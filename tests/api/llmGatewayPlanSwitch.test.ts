import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPlanOrder,
  fetchPlanQuote,
  isPlanQuoteUnsupported,
  planRole,
  GatewayApiError,
  type GatewayPlanQuote,
  type GatewaySubscriptionPlan,
} from "@/lib/api/llm-gateway";

// 换档契约的 API 层。这些 case 盯的是三件会直接让用户付错钱的事：
// 1. 四种 action 的报价都能原样反序列化（客户端一个数字都不复算）。
// 2. 老服务端的 404 是「没这个能力」，必须可识别，不能静默变成 null ——
//    调用方对「没能力」和「网络挂了」的正确处理完全相反。
// 3. 下单请求里不能再出现 start_after_current，而 as_extra 必须真的发出去。

const TOKEN_KEY = "llm-gateway-oauth";
const BASE_URL_KEY = "llm-gateway-base-url";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

let captured: CapturedRequest[] = [];

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    captured.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(captured[index].init.body));
}

beforeEach(() => {
  captured = [];
  localStorage.clear();
  localStorage.setItem(BASE_URL_KEY, "https://gw.test");
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({
      token_type: "Bearer",
      access_token: "access-token",
      expires_in: 3600,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function quoteBody(
  action: GatewayPlanQuote["action"],
  overrides: Partial<GatewayPlanQuote> = {},
): GatewayPlanQuote {
  return {
    action,
    credit_applied_micros: 66_666_666,
    amount_due_micros: 133_333_334,
    amount_cents: 96_000,
    new_valid_until: "2026-09-01T00:00:00Z",
    resulting_balance_micros: 0,
    current_tier: "pro",
    target_tier: "business",
    ...overrides,
  };
}

describe("fetchPlanQuote", () => {
  it.each([["upgrade_now"], ["queue"], ["activate_now"], ["extra"]] as const)(
    "反序列化 action=%s 的报价",
    async (action) => {
      mockFetchOnce(200, quoteBody(action));

      const quote = await fetchPlanQuote("business", "1m");

      expect(quote.action).toBe(action);
      // 四个数字必须原样带出来 —— 结账页要同屏显示它们，缺一个用户就看不懂
      // 到期日为什么变短了。
      expect(quote.credit_applied_micros).toBe(66_666_666);
      expect(quote.amount_due_micros).toBe(133_333_334);
      expect(quote.new_valid_until).toBe("2026-09-01T00:00:00Z");
      expect(quote.resulting_balance_micros).toBe(0);
    },
  );

  it("打到 quote 端点并带上鉴权", async () => {
    mockFetchOnce(200, quoteBody("queue"));

    await fetchPlanQuote("pro", "3m");

    expect(captured[0].url).toBe("https://gw.test/v1/plans/pro/quote");
    expect(captured[0].init.method).toBe("POST");
    expect(
      (captured[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer access-token");
    expect(requestBody()).toEqual({ period: "3m" });
  });

  it("自选档带上 price_usd，加量包带上 as_extra", async () => {
    mockFetchOnce(200, quoteBody("extra"));

    await fetchPlanQuote("custom", "1w", 30, true);

    expect(requestBody()).toEqual({
      period: "1w",
      price_usd: 30,
      as_extra: true,
    });
  });

  it("as_extra=false 时不发这个字段", async () => {
    mockFetchOnce(200, quoteBody("queue"));

    await fetchPlanQuote("pro", "1m", undefined, false);

    expect(requestBody()).toEqual({ period: "1m" });
  });

  it("老服务端 404 抛出可识别的错误，不是静默返回 null", async () => {
    mockFetchOnce(404, { error: "not_found" });

    // 调用方要能分辨「服务端没这个能力」和「网络挂了」——前者该隐藏整个
    // 换档 UI，后者该提示重试。吞成 null 就分不出来了。
    const error = await fetchPlanQuote("pro").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect((error as GatewayApiError).status).toBe(404);
    expect(isPlanQuoteUnsupported(error)).toBe(true);
  });

  it("非 404 的失败不算「不支持换档」", async () => {
    // 一次 401 或断网就把换档 UI 藏掉的话，用户会以为功能没了。
    expect(isPlanQuoteUnsupported(new GatewayApiError(401, ""))).toBe(false);
    expect(isPlanQuoteUnsupported(new GatewayApiError(500, ""))).toBe(false);
    expect(isPlanQuoteUnsupported(new TypeError("Failed to fetch"))).toBe(
      false,
    );
  });
});

describe("createPlanOrder", () => {
  const orderBody = {
    order_id: "pay_1",
    account_id: "acct_1",
    amount_credits: 200_000_000,
    amount_cents: 96_000,
    exchange_rate: 7.2,
    currency: "CNY",
    status: "pending",
    code_url: "weixin://wxpay/bizpayurl?pr=test",
    plan_id: "business",
    period: "1m",
    duration_days: 30,
    months: 1,
  };

  it("不再发送 start_after_current", async () => {
    mockFetchOnce(200, orderBody);

    // 老调用点仍可能传第 4 个参数；它必须被丢弃而不是变成别的语义。
    await createPlanOrder("pro", "1m", undefined, true);

    expect(requestBody()).toEqual({ period: "1m" });
    expect(requestBody()).not.toHaveProperty("start_after_current");
  });

  it("asExtra 映射到 as_extra", async () => {
    mockFetchOnce(200, { ...orderBody, action: "extra" });

    const order = await createPlanOrder(
      "starter",
      "1m",
      undefined,
      false,
      true,
    );

    expect(requestBody()).toEqual({ period: "1m", as_extra: true });
    expect(order.action).toBe("extra");
  });

  it("零元单：响应没有 code_url 也能正常解析", async () => {
    const { code_url: _omitted, ...withoutQR } = orderBody;
    mockFetchOnce(200, {
      ...withoutQR,
      action: "upgrade_now",
      amount_cents: 0,
      amount_due_micros: 0,
      resulting_balance_micros: 40_000_000,
      new_valid_until: "2026-09-01T00:00:00Z",
    });

    const order = await createPlanOrder("business", "1m");

    // 这是无二维码路径的判据。只看 code_url，不看 order_id —— 服务端对
    // 零元单是否建 payment_orders 记录还没定。
    expect(order.code_url).toBeUndefined();
    expect(order.amount_due_micros).toBe(0);
    expect(order.resulting_balance_micros).toBe(40_000_000);
  });
});

describe("planRole", () => {
  function plan(role?: string): GatewaySubscriptionPlan {
    return {
      grant_id: "g_1",
      tier: "pro",
      usage_micros_per_5h: 100_000_000,
      usage_micros_per_week: 500_000_000,
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2026-07-31T00:00:00Z",
      ...(role ? { role: role as GatewaySubscriptionPlan["role"] } : {}),
    };
  }

  it("缺失时按 subscription 处理", () => {
    // 老服务端不返回 role。默认成 subscription 才能让所有套餐落在
    // 「我的套餐」块里，退化成加换档之前的行为。
    expect(planRole(plan())).toBe("subscription");
  });

  it("显式的两种角色原样返回", () => {
    expect(planRole(plan("subscription"))).toBe("subscription");
    expect(planRole(plan("extra"))).toBe("extra");
  });
});
