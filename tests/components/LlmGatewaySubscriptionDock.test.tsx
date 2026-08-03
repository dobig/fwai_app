import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { LlmGatewaySubscriptionDock } from "@/components/llm-gateway/LlmGatewaySubscriptionDock";
import { formatPlanDate } from "@/components/llm-gateway/planCatalog";
import {
  ActiveAppProvider,
  useActiveApp,
} from "@/components/active-app-provider";
import * as gateway from "@/lib/api/llm-gateway";
import { GatewayApiError } from "@/lib/api/llm-gateway";
import { providersApi, type AppId } from "@/lib/api";
import { createTestQueryClient } from "../utils/testQueryClient";
import { recordUpgradeSignal, resetUpgradeSignal } from "@/lib/clientUpgrade";

// 这些 case 围绕两个问题：
// 1. 本地缓存的 subscription 是登录那一刻的快照，管理员在后台开通套餐不经过
//    客户端。凡是拿 isActive 挡住用户的地方，都必须先跟服务端对一次账。
// 2. 转发只该动当前选中的那个 CLI，切走时把上一个还原回去。
const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toasts }));

const LOGIN_KEY = "llm-gateway-login";
const TOKEN_KEY = "llm-gateway-oauth";
const DOCK_OPEN_KEY = "llm-gateway-dock-open";

function seedLoggedOutOfPlan() {
  // 已登录、缓存说「未开通」——被管理员升级前客户端看到的正是这个状态。
  const login: gateway.GatewayLoginResult = {
    token_type: "Bearer",
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    user: {
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user",
      email_verified: true,
    },
    account: { id: "acct_1" },
    subscription: { active: false },
  };
  localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  localStorage.setItem(TOKEN_KEY, JSON.stringify(login));
  localStorage.setItem(DOCK_OPEN_KEY, "1");
}

/** 已登录且套餐是开着的——不需要跟服务端对账就能直接开转发。 */
function seedActivePlan() {
  seedLoggedOutOfPlan();
  const login = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
  login.subscription = { active: true, tier: "starter" };
  localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
}

/**
 * 桩一次服务端报价。付款前必须先拿到报价 —— 拿不到就不放行，所以凡是走到
 * 下单的 case 都要先桩这个。
 */
function mockQuote(patch: Partial<gateway.GatewayPlanQuote> = {}) {
  return vi.spyOn(gateway, "fetchPlanQuote").mockResolvedValue({
    action: "activate_now",
    credit_applied_micros: 0,
    amount_due_micros: 100_000_000,
    amount_cents: 72000,
    new_valid_until: "2026-08-31T12:00:00Z",
    resulting_balance_micros: 0,
    current_tier: "",
    target_tier: "pro",
    ...patch,
  });
}

/** 服务端说：套餐是开着的（管理员刚开的）。 */
function serverSaysActive() {
  return {
    subscription: {
      active: true,
      tier: "starter",
      valid_until: "2099-01-01T00:00:00Z",
    },
    user: {
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user" as const,
      email_verified: true,
    },
  };
}

// 切 app 的入口。用真的 context 而不是重挂组件——切 app 走的是 activeApp 变化那条
// 路径，重挂等于换了一个新组件，测不到状态该不该跟着变。
function SwitchTo({ app }: { app: AppId }) {
  const { setActiveApp } = useActiveApp();
  return <button onClick={() => setActiveApp(app)}>切到 {app}</button>;
}

function renderDock(activeApp: AppId = "claude", ...switchTo: AppId[]) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ActiveAppProvider initialApp={activeApp}>
        {switchTo.map((app) => (
          <SwitchTo key={app} app={app} />
        ))}
        <LlmGatewaySubscriptionDock />
      </ActiveAppProvider>
    </QueryClientProvider>,
  );
}

const startButton = () => screen.findByText(/^开启转发/);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  // 升级信号存在模块级，不清会漏到后面的 case 里把购买入口一直挡着。
  resetUpgradeSignal();
  toasts.error.mockClear();
  toasts.info.mockClear();
  toasts.success.mockClear();
  toasts.warning.mockClear();
  // 用量在这些 case 里不是重点，但组件挂载就会拉，给个空窗口避免噪音。
  vi.spyOn(gateway, "fetchGatewayUsage").mockResolvedValue({
    five_hour: null,
    seven_day: null,
  });
  vi.spyOn(providersApi, "isForwarding").mockResolvedValue(false);
  vi.spyOn(providersApi, "getAll").mockResolvedValue({});
  vi.spyOn(providersApi, "add").mockResolvedValue(undefined as never);
  vi.spyOn(providersApi, "update").mockResolvedValue(undefined as never);
  vi.spyOn(providersApi, "startForwarding").mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(providersApi, "stopForwarding").mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(providersApi, "removeManaged").mockResolvedValue(true);
  vi.spyOn(providersApi, "updateTrayMenu").mockResolvedValue(
    undefined as never,
  );
});

describe("LlmGatewaySubscriptionDock 开启转发", () => {
  it("缓存说未开通、服务端说已开通时，直接开启转发而不是催购买", async () => {
    seedLoggedOutOfPlan();
    const fetchSub = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockResolvedValue(serverSaysActive());

    renderDock();
    await userEvent.click(await startButton());

    await waitFor(() => expect(fetchSub).toHaveBeenCalled());
    // 服务端已放行 —— 不该再被前端的陈旧状态挡在门外。
    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalled(),
    );
    expect(toasts.info).not.toHaveBeenCalledWith("请先购买会员再开启转发");
    // 徽标同步刷新成管理员开的套餐。
    expect(await screen.findByText("$20")).toBeInTheDocument();
  });

  it("服务端确认没有套餐时，才提示购买", async () => {
    seedLoggedOutOfPlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue({
      subscription: { active: false },
    });

    renderDock();
    await userEvent.click(await startButton());

    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledWith("请先购买会员再开启转发"),
    );
    expect(providersApi.startForwarding).not.toHaveBeenCalled();
  });

  it("网络失败时不谎称需要购买", async () => {
    seedLoggedOutOfPlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    renderDock();
    await userEvent.click(await startButton());

    // 断网时「请先购买会员」是假话，会把已付费的人推去重复下单。
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "无法确认套餐状态，请检查网络后重试",
      ),
    );
    expect(toasts.info).not.toHaveBeenCalledWith("请先购买会员再开启转发");
    expect(providersApi.startForwarding).not.toHaveBeenCalled();
  });

  it("401 先换 token 再重试，不把登录过期误判成没有套餐", async () => {
    seedLoggedOutOfPlan();
    const fetchSub = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockRejectedValueOnce(new GatewayApiError(401, ""))
      .mockResolvedValueOnce(serverSaysActive());
    const refresh = vi.spyOn(gateway, "refreshGatewayToken").mockResolvedValue({
      token_type: "Bearer",
      access_token: "new-access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    });

    renderDock();
    await userEvent.click(await startButton());

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSub).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalled(),
    );
  });
});

// 转发是按 app 隔离的：用户可以让 Claude 走网关，Codex 继续用他自己的配置。
// 以前这里遍历 claude+codex，两个 app 的 live 配置会被一起改写。
describe("LlmGatewaySubscriptionDock 按 app 隔离", () => {
  it("选中 Claude 时只写 Claude 的配置，绝不碰 Codex", async () => {
    seedActivePlan();

    renderDock("claude");
    await userEvent.click(await startButton());

    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalledTimes(1),
    );
    expect(providersApi.startForwarding).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.any(String),
      expect.any(String),
    );
    const apps = vi
      .mocked(providersApi.startForwarding)
      .mock.calls.map((c) => c[1]);
    expect(apps).not.toContain("codex");
    // 条目也只补当前 app：后端的 add 在没有 current 时会顺手写 live。
    const addedApps = vi.mocked(providersApi.add).mock.calls.map((c) => c[1]);
    expect(addedApps).not.toContain("codex");
  });

  it("选中 Codex 时只写 Codex 的配置", async () => {
    seedActivePlan();

    renderDock("codex");
    await userEvent.click(await startButton());

    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalledTimes(1),
    );
    expect(providersApi.startForwarding).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      expect.any(String),
      expect.any(String),
    );
  });

  it("按钮反映的是当前 app 自己的状态", async () => {
    seedActivePlan();
    // Claude 在转发，Codex 没有。选中 Codex 时按钮该是「开启转发」。
    vi.mocked(providersApi.isForwarding).mockImplementation(async (app) =>
      app === "claude" ? true : false,
    );

    renderDock("codex");

    expect(await screen.findByText(/^开启转发（Codex）/)).toBeInTheDocument();
  });

  it("结束转发只还原当前 app", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockResolvedValue(true);

    renderDock("claude");
    await userEvent.click(await screen.findByText(/^结束转发/));

    await waitFor(() =>
      expect(providersApi.stopForwarding).toHaveBeenCalledWith("claude"),
    );
    const apps = vi
      .mocked(providersApi.stopForwarding)
      .mock.calls.map((c) => c[0]);
    expect(apps).not.toContain("codex");
  });

  it("Gemini 不支持转发：按钮置灰且点不动", async () => {
    seedActivePlan();

    renderDock("gemini");
    const button = await screen.findByText(/暂不支持转发/);

    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(providersApi.startForwarding).not.toHaveBeenCalled();
    // 连条目都不该往 Gemini 的列表里补。
    const addedApps = vi.mocked(providersApi.add).mock.calls.map((c) => c[1]);
    expect(addedApps).not.toContain("gemini");
  });
});

// 隔离之后每个 app 的配置互不影响，切走还去停掉就是多余的干预：用户在 Claude 上
// 开了转发，切去 Codex 看一眼再切回来，转发本就该还在。
describe("LlmGatewaySubscriptionDock 切换 app", () => {
  it("切到别的 CLI 时不动上一个的转发", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockResolvedValue(true);

    renderDock("claude", "codex");
    // 等首次状态读完，确认 Claude 确实在转发中，否则「没被停掉」是废断言。
    await screen.findByText(/^结束转发/);

    await userEvent.click(screen.getByText("切到 codex"));

    // 面板换成了 Codex 的状态（同样在转发中，mock 对两个 app 都返回 true）。
    await screen.findByText("结束转发（Codex）");
    // 关键：Claude 那边一个字节都没动，也没弹「已结束并还原」。
    expect(providersApi.stopForwarding).not.toHaveBeenCalled();
    expect(providersApi.startForwarding).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalledWith(
      expect.stringContaining("转发已结束"),
    );
  });

  it("切回来时转发还在", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockImplementation(
      async (app) => app === "claude",
    );

    renderDock("claude", "codex", "claude");
    await screen.findByText("结束转发（Claude Code）");

    // 去 Codex 看一眼：它自己没转发，按钮是「开启转发」。
    await userEvent.click(screen.getByText("切到 codex"));
    await screen.findByText("开启转发（Codex）");

    // 切回来，Claude 的转发仍然在——期间没有任何一次 stopForwarding。
    await userEvent.click(screen.getByText("切到 claude"));
    await screen.findByText("结束转发（Claude Code）");
    expect(providersApi.stopForwarding).not.toHaveBeenCalled();
  });
});

describe("LlmGatewaySubscriptionDock 购买套餐", () => {
  it("进购买屏前先对账，已开通的人看得到当前套餐而不是空白", async () => {
    seedLoggedOutOfPlan();
    const fetchSub = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockResolvedValue(serverSaysActive());

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));

    // 不刷新的话购买屏的「当前套餐」提示块（条件是 isActive）整块不渲染，
    // 用户看不到已有套餐的线索，一路点下去会开出一张真实订单。
    await waitFor(() => expect(fetchSub).toHaveBeenCalled());
    expect(await screen.findByText("$20")).toBeInTheDocument();
  });

  it("刷新发现邮箱未验证时改道验证屏", async () => {
    seedLoggedOutOfPlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue({
      subscription: { active: false },
      user: {
        id: "user_1",
        username: "tester",
        email: "tester@example.com",
        role: "user",
        email_verified: false,
      },
    });

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));

    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledWith("购买前请先验证邮箱"),
    );
  });
});

describe("LlmGatewaySubscriptionDock 登出", () => {
  it("登出时把所有 app 的转发都停掉", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockResolvedValue(true);
    vi.spyOn(gateway, "revokeGatewayToken").mockResolvedValue(undefined);

    renderDock("claude");
    await userEvent.click(await screen.findByText("登出"));

    // token 已经作废，任何还压着网关 endpoint 的 app 都得还原——正常情况下只有
    // 一个，遍历是防不变量被破坏时的残留。
    await waitFor(() =>
      expect(providersApi.stopForwarding).toHaveBeenCalledWith("claude"),
    );
    expect(providersApi.stopForwarding).toHaveBeenCalledWith("codex");
  });
});

// 套餐可以叠加，一个用户同时可能有好几个在跑，还可能有一个排队等生效。
// 这些 case 盯的是两件用户会付错钱的事：账户页要看得出手里有几个套餐，
// 下单时「换档还是买加量包」的意图必须真的传到服务端。
describe("LlmGatewaySubscriptionDock 套餐叠加", () => {
  /** 已登录，服务端说手里有两个生效套餐 + 一个待生效。 */
  function seedStackedPlans() {
    seedLoggedOutOfPlan();
    const login = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
    login.subscription = {
      active: true,
      tier: "pro",
      usage_micros_per_5h: 110_000_000,
      usage_micros_per_week: 550_000_000,
      valid_until: "2099-01-01T00:00:00Z",
      plans: [
        {
          grant_id: "g_week",
          tier: "custom",
          usage_micros_per_5h: 10_000_000,
          usage_micros_per_week: 50_000_000,
          valid_from: "2026-07-01T00:00:00Z",
          valid_until: "2026-07-08T00:00:00Z",
        },
        {
          grant_id: "g_pro",
          tier: "pro",
          usage_micros_per_5h: 100_000_000,
          usage_micros_per_week: 500_000_000,
          valid_from: "2026-07-01T00:00:00Z",
          valid_until: "2026-07-31T00:00:00Z",
        },
        {
          grant_id: "g_queued",
          tier: "pro",
          usage_micros_per_5h: 100_000_000,
          usage_micros_per_week: 500_000_000,
          valid_from: "2026-07-31T00:00:00Z",
          valid_until: "2026-08-30T00:00:00Z",
          pending: true,
        },
      ],
    };
    localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  }

  it("账户页逐个列出持有的套餐，并说明排队中的那个何时切换", async () => {
    seedStackedPlans();
    renderDock();

    // 老服务端不返回 role，所有套餐都落在「我的套餐」块里。
    expect(await screen.findByText("我的套餐")).toBeTruthy();
    // 不显示 5h/周的具体金额。这条 tier="custom"（admin 发的专属额度）
    // 没有干净的倍数可言，档位名就是全部说明，不再补一句描述。
    expect(screen.getByText("专属额度")).toBeTruthy();
    expect(screen.getAllByText("5× Starter 用量").length).toBe(1);
    // 排队中的那个要说清换的是哪一档、什么时候换，否则用户以为额度已经到账了。
    expect(screen.getByText(/到期后自动切换到 \$100/)).toBeTruthy();
  });

  it("换档路径下单不带 as_extra", async () => {
    seedStackedPlans();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_1",
      code_url: "weixin://wxpay/bizpayurl?pr=test",
      plan_id: "pro",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 100_000_000,
      amount_cents: 72000,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    // 有生效套餐时先问意图，默认停在「更换 / 续费套餐」——粘住上一次选的
    // 加量包会让来换档的人不看提示就买错东西。
    expect(await screen.findByText("更换 / 续费套餐")).toBeTruthy();
    await userEvent.click(await screen.findByText("$100"));
    mockQuote({ action: "upgrade_now" });
    await userEvent.click(await screen.findByText(/^下一步/));
    await userEvent.click(await screen.findByText(/^微信支付/));

    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    // 排队与否不再由客户端选，服务端按档位高低判定（quote 的 action）。
    expect(createOrder.mock.calls[0][4]).toBe(false);
  });

  it("没有生效套餐时不问意图，直接进档位列表", async () => {
    seedLoggedOutOfPlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue({
      subscription: { active: false },
      user: {
        id: "user_1",
        username: "tester",
        email: "tester@example.com",
        role: "user" as const,
        email_verified: true,
      },
    });
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_1",
      code_url: "weixin://wxpay/bizpayurl?pr=test",
      plan_id: "pro",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 100_000_000,
      amount_cents: 72000,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));

    // 首购用户买不了加量包，多问一道选择题只会让人困惑。
    expect(await screen.findByText("选择套餐 · 微信支付")).toBeTruthy();
    expect(screen.queryByText("购买加量包")).toBeNull();
    await userEvent.click(await screen.findByText("$100"));
    mockQuote();
    await userEvent.click(await screen.findByText(/^下一步/));
    await userEvent.click(await screen.findByText(/^微信支付/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(createOrder.mock.calls[0][4]).toBe(false);
  });

  it("选加量包意图后按单位数 + 周期下单，带上 as_extra", async () => {
    seedStackedPlans();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_2",
      code_url: "weixin://wxpay/bizpayurl?pr=extra",
      plan_id: "custom",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 40_000_000,
      amount_cents: 28800,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("购买加量包"));

    // 加量包没有档位卡片，只有两个输入：买几个单位、买多久。
    expect(screen.queryByText("选择套餐 · 微信支付")).toBeNull();
    const units = await screen.findByRole("spinbutton");
    await userEvent.clear(units);
    await userEvent.type(units, "2");
    const quote = mockQuote({
      action: "extra",
      amount_due_micros: 40_000_000,
      target_tier: "extra",
    });
    await userEvent.click(await screen.findByText(/^下一步/));
    await waitFor(() => expect(quote).toHaveBeenCalled());
    // 报价也要带 as_extra，否则服务端按换档算钱，结账页上的四个数字全是错的。
    expect(quote.mock.calls[0][3]).toBe(true);
    await userEvent.click(await screen.findByText(/^微信支付/));

    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    const [planId, period, priceUSD, , asExtra] = createOrder.mock.calls[0];
    // 加量包打的是 /v1/plans/extra/orders。历史上这里写的是 "custom",
    // 服务端靠 as_extra 覆盖才没出事 —— 那个绕道已经拆掉。
    expect(planId).toBe("extra");
    expect(period).toBe("1m");
    expect(priceUSD).toBe(40);
    // 漏掉 as_extra 的话服务端会把这一单当成换档，直接顶掉现有套餐。
    expect(asExtra).toBe(true);
  });

  // 加量包页是「不显示额度金额」这条规则最后一个漏网的渲染点：档位卡片、
  // 周期页、账户页都改完之后，它还在印 `5 小时 $40 · 每周 $200`。没有断言
  // 钉住的话，下次有人想「这里给个具体数更清楚」就又回去了。
  it("加量包页只说倍数，不印 5h/周的美元额度", async () => {
    seedStackedPlans();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_3",
      code_url: "weixin://wxpay/bizpayurl?pr=extra",
      plan_id: "extra",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 40_000_000,
      amount_cents: 28800,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("购买加量包"));
    const units = await screen.findByRole("spinbutton");
    await userEvent.clear(units);
    await userEvent.type(units, "2");

    expect(await screen.findByText(/2 单位 = 2× Starter 的用量/)).toBeTruthy();
    // `单位数（1 单位 = $20/月）` 那行是**价格**，必须留着；被禁的是把价格
    // 换算成 5h / 每周的额度金额。所以只查这两个窗口名旁边的美元数。
    expect(document.body.textContent).not.toMatch(/5 小时 \$/);
    expect(document.body.textContent).not.toMatch(/每周 \$/);

    mockQuote({
      action: "extra",
      amount_due_micros: 40_000_000,
      target_tier: "extra",
    });
    await userEvent.click(await screen.findByText(/^下一步/));
    await userEvent.click(await screen.findByText(/^微信支付/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());

    // 扫码页按单位数报数，不是按自报金额。自选档删掉之后 `自选 $X` 那个
    // 分支已经不可达（priceUSD 只在 asExtra 时才有值），这里钉住它别复活。
    expect(await screen.findByText(/加量包 2 单位/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/自选 \$/);
  });

  it("单位数非法时不让下单", async () => {
    seedStackedPlans();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder");

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("购买加量包"));
    const units = await screen.findByRole("spinbutton");
    await userEvent.clear(units);
    await userEvent.type(units, "0");

    expect(await screen.findByText(/请输入 1–99 的整数/)).toBeTruthy();
    await userEvent.click(screen.getByText(/^下一步/));
    expect(createOrder).not.toHaveBeenCalled();
  });
});

// 结账页。金额抵扣模式下升档**不延长到期日**，而是按新买的时长重算——
// 用户看到到期日从 300 天后变成 30 天后一定会炸，唯一的解法是付款前把
// 抵扣额/新到期日/剩余余额/实付四个数字同时摆出来。
describe("LlmGatewaySubscriptionDock 换档结账页", () => {
  /** 走到结账页：有生效套餐 → 选 $200 档 → 下一步。 */
  async function openCheckout(patch: Partial<gateway.GatewayPlanQuote>) {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const quote = mockQuote(patch);
    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    await userEvent.click(await screen.findByText(/^下一步/));
    await waitFor(() => expect(quote).toHaveBeenCalled());
    return quote;
  }

  it("Pro 剩 300 天升 Business 月付：新到期日、抵扣额、余额同屏可见", async () => {
    // 本 epic 的核心用例。旧套餐剩的 300 天折成 $666.67 余额，抵扣掉
    // $200 的月费后还剩 $466.67，新到期日是 30 天后而不是 300 天后。
    await openCheckout({
      action: "upgrade_now",
      credit_applied_micros: 200_000_000,
      amount_due_micros: 0,
      amount_cents: 0,
      new_valid_until: "2026-09-01T12:00:00Z",
      resulting_balance_micros: 466_670_000,
      current_tier: "pro",
      target_tier: "business",
    });

    // 到期日必须显示在同一屏上——只说「已抵扣」而不说到期日变了，
    // 用户会在下个月发现套餐没了才反应过来。
    expect(await screen.findByText("2026/9/1")).toBeTruthy();
    expect(screen.getByText("-$200")).toBeTruthy();
    expect(screen.getByText("$466.67")).toBeTruthy();
    expect(screen.getByText(/余额自动用于后续购买/)).toBeTruthy();
    expect(screen.getByText(/立即升级到 \$200/)).toBeTruthy();
    // 抵扣够了就没有微信单可下，按钮不能写「微信支付 $0」。
    expect(screen.getByText(/确认（余额已够，无需付款）/)).toBeTruthy();
  });

  it("queue 的切换日期取服务端的 new_valid_from，不是当前档到期日", async () => {
    // 生效日一律以服务端算的为准，客户端不自己推。历史上两者真的会差一整个
    // 周期（那时排队会排到订阅层最远的到期日），现在排队单改成被替换，两者
    // 通常一致 —— 但「通常一致」不是「可以自己算」：周期、加量包、免费档都可能
    // 让服务端选一个客户端猜不到的日子。这里用一个不一致的报价钉住这条规矩。
    await openCheckout({
      action: "queue",
      amount_due_micros: 20_000_000,
      // 当前生效档 2099-01-01 到期（serverSaysActive），但队尾在一个月后。
      new_valid_from: "2099-02-01T00:00:00Z",
      new_valid_until: "2099-03-01T00:00:00Z",
      current_tier: "pro",
      target_tier: "starter",
    });

    // 日期用同一个格式化函数算，免得把测试钉死在某个时区上。
    const queueTail = formatPlanDate("2099-02-01T00:00:00Z");
    const liveEnd = formatPlanDate("2099-01-01T00:00:00Z");
    expect(queueTail).not.toBe(liveEnd);
    expect(
      await screen.findByText(`当前套餐到期后（${queueTail}）自动切换到 $20`),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${liveEnd}.*自动切换`))).toBeNull();
  });

  it("老服务端不发 new_valid_from 时退回当前档到期日", async () => {
    await openCheckout({
      action: "queue",
      amount_due_micros: 20_000_000,
      new_valid_until: "2099-02-01T00:00:00Z",
      current_tier: "pro",
      target_tier: "starter",
    });

    expect(
      await screen.findByText(
        `当前套餐到期后（${formatPlanDate("2099-01-01T00:00:00Z")}）自动切换到 $20`,
      ),
    ).toBeTruthy();
  });

  it("queue 抵扣非零时把抵扣额写进主文案", async () => {
    // 用户先排了一个 $20 降档，又改主意排 $100。服务端把那 $20 全额折成抵扣，
    // 实付只剩 $80。主文案不提这件事的话，用户会以为自己第二次又付了全款 ——
    // 「余额抵扣」那一行写的是 -$20，光看它分不清抵扣的是余额还是上一单。
    await openCheckout({
      action: "queue",
      credit_applied_micros: 20_000_000,
      amount_due_micros: 80_000_000,
      new_valid_from: "2099-01-01T00:00:00Z",
      new_valid_until: "2099-02-01T00:00:00Z",
      current_tier: "business",
      target_tier: "pro",
    });

    expect(
      await screen.findByText(/自动切换到 \$100，已排队套餐的费用折算抵扣 \$20/),
    ).toBeTruthy();
  });

  it("queue 抵扣为零时不提抵扣", async () => {
    // 绝大多数降档是这条路径。写「抵扣 $0」只会让用户以为自己亏了。
    await openCheckout({
      action: "queue",
      credit_applied_micros: 0,
      amount_due_micros: 20_000_000,
      new_valid_from: "2099-01-01T00:00:00Z",
      current_tier: "pro",
      target_tier: "starter",
    });

    expect(await screen.findByText(/自动切换到 \$20$/)).toBeTruthy();
    // 主文案里不能出现抵扣那一句。（下面那条琥珀色警告里有「折算抵扣」四个字，
    // 那是在说「以后改主意钱不会白付」，跟这一单的抵扣额是两回事。）
    expect(screen.queryByText(/已排队套餐的费用折算抵扣/)).toBeNull();
  });

  it("queue 弹二次确认，取消则不下单", async () => {
    const createOrder = vi.spyOn(gateway, "createPlanOrder");
    await openCheckout({
      action: "queue",
      credit_applied_micros: 0,
      amount_due_micros: 20_000_000,
      new_valid_until: "2099-02-01T00:00:00Z",
      resulting_balance_micros: 0,
      current_tier: "pro",
      target_tier: "starter",
    });

    expect(await screen.findByText(/自动切换到 \$20/)).toBeTruthy();
    // 「不退款」仍然成立（换不回现金），「不可撤销」不成立了：再买别的档时
    // 这笔钱会全额折成抵扣。文案说错哪一边都会劝退一批用户。
    expect(screen.getByText(/此操作不退款/)).toBeTruthy();
    expect(screen.getByText(/全额折算抵扣新套餐/)).toBeTruthy();
    expect(screen.queryByText(/不可撤销/)).toBeNull();

    await userEvent.click(screen.getByText(/^微信支付/));
    // 钱是真要付出去的，一行小字挡不住误操作。
    expect(await screen.findByText("确认排队切换套餐？")).toBeTruthy();
    expect(
      screen.getAllByText(/切换前当前套餐照常可用/).length,
    ).toBeGreaterThan(0);

    await userEvent.click(screen.getByText("再想想"));
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("queue 确认后才下单", async () => {
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_q",
      code_url: "weixin://wxpay/bizpayurl?pr=q",
      plan_id: "business",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 20_000_000,
      amount_cents: 14400,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);
    await openCheckout({
      action: "queue",
      amount_due_micros: 20_000_000,
      target_tier: "starter",
    });

    await userEvent.click(await screen.findByText(/^微信支付/));
    await userEvent.click(await screen.findByText("确认切换"));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
  });

  it("activate_now / extra 各有自己的文案", async () => {
    await openCheckout({ action: "activate_now", target_tier: "business" });
    expect(await screen.findByText(/立即生效：\$200/)).toBeTruthy();
    // 立即生效不该出现那条不退款的警告——它只属于排队。
    expect(screen.queryByText(/此操作不退款/)).toBeNull();
  });

  it("报价失败不放行付款", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const quote = vi
      .spyOn(gateway, "fetchPlanQuote")
      .mockRejectedValue(new Error("网络开小差了"));
    const createOrder = vi.spyOn(gateway, "createPlanOrder");

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    await userEvent.click(await screen.findByText(/^下一步/));
    await waitFor(() => expect(quote).toHaveBeenCalled());

    // 没有报价就意味着客户端不知道点下去会发生什么——可能立即换档，
    // 也可能排队到下个月，而后者不可撤销。
    expect(await screen.findByText("网络开小差了")).toBeTruthy();
    expect(screen.queryByText(/^微信支付 \$/)).toBeNull();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("老服务端没有 quote 端点时退回旧流程直接下单", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    vi.spyOn(gateway, "fetchPlanQuote").mockRejectedValue(
      new GatewayApiError(404, "not_found"),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_old",
      code_url: "weixin://wxpay/bizpayurl?pr=old",
      plan_id: "business",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 200_000_000,
      amount_cents: 144000,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    await userEvent.click(await screen.findByText(/^下一步/));

    // 老服务端本来也不做换档判定，卡住等报价只会让人买不了东西。
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(await screen.findByText("微信扫码支付")).toBeTruthy();
  });
});

// 零元单。抵扣额 ≥ 新套餐价时服务端不下微信单（微信最小收款 1 分），响应里
// 没有 code_url。旧流程假定一定有二维码，会渲染一个空码然后无限轮询一个可能
// 根本不存在的订单——这是整个改造里漏了就彻底卡住用户的那条分支。
describe("LlmGatewaySubscriptionDock 零元单", () => {
  async function buyWith(
    order: Record<string, unknown>,
    quotePatch: Partial<gateway.GatewayPlanQuote> = {},
  ) {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    mockQuote({
      action: "upgrade_now",
      credit_applied_micros: 250_000_000,
      amount_due_micros: 0,
      amount_cents: 0,
      new_valid_until: "2026-09-01T12:00:00Z",
      resulting_balance_micros: 50_000_000,
      current_tier: "pro",
      target_tier: "business",
      ...quotePatch,
    });
    const getOrder = vi.spyOn(gateway, "getPaymentOrder");
    const createOrder = vi
      .spyOn(gateway, "createPlanOrder")
      .mockResolvedValue(
        order as unknown as Awaited<ReturnType<typeof gateway.createPlanOrder>>,
      );

    const { container } = renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    await userEvent.click(await screen.findByText(/^下一步/));
    await userEvent.click(
      await screen.findByText(/^(确认（余额已够|微信支付 \$)/),
    );
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    return { getOrder, container };
  }

  it("响应缺 code_url 时不渲染二维码、不轮询，直接进成功态", async () => {
    // order_id 故意留空：服务端对零元单是否建 payment_orders 记录还没最终定
    // （llm_gateway#192 二选一），客户端只能靠 code_url 分流。
    const { getOrder } = await buyWith({
      plan_id: "business",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 0,
      amount_cents: 0,
      exchange_rate: 7.2,
      currency: "CNY",
      action: "upgrade_now",
      new_valid_until: "2026-09-01T12:00:00Z",
      resulting_balance_micros: 50_000_000,
    });

    expect(await screen.findByText("已完成，无需付款")).toBeTruthy();
    expect(screen.queryByText("微信扫码支付")).toBeNull();
    // 用户一分钱没付但套餐确实变了，只说「成功」他会以为没生效。
    expect(screen.getByText(/已用账户余额完成/)).toBeTruthy();
    expect(screen.getByText("2026/9/1")).toBeTruthy();
    expect(screen.getByText("$50")).toBeTruthy();
    // 轮询一个可能不存在的订单会让用户看到一串报错，最后还被告知支付未完成。
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("部分抵扣仍走二维码路径", async () => {
    // 回归断言：0 < amount_due < 套餐价 时服务端照常下微信单，这条路不能
    // 被零元单的分支顺手改掉。
    const { container } = await buyWith(
      {
        order_id: "pay_partial",
        code_url: "weixin://wxpay/bizpayurl?pr=partial",
        plan_id: "business",
        period: "1m",
        duration_days: 30,
        months: 1,
        amount_credits: 50_000_000,
        amount_cents: 36000,
        exchange_rate: 7.2,
        currency: "CNY",
      },
      { amount_due_micros: 50_000_000, amount_cents: 36000 },
    );

    expect(await screen.findByText("微信扫码支付")).toBeTruthy();
    expect(screen.queryByText("已完成，无需付款")).toBeNull();
    // 二维码真的画出来了（轮询是 3 秒一次的 interval，测里等它太慢）。
    expect(container.querySelector("svg[height='168']")).toBeTruthy();
  });

  it("结账金额和二维码金额都取服务端，本地算出来的不作数", async () => {
    // $200 档买 1 个月，本地预览算出来是 $200。服务端说抵扣后只要 $37.5 ——
    // 结账页和二维码页显示的都必须是服务端那个数。本地算法和服务端只要有
    // 一处不一致，用户看到的价格就和实际扣款不同。
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    mockQuote({
      action: "upgrade_now",
      credit_applied_micros: 162_500_000,
      amount_due_micros: 37_500_000,
      amount_cents: 27000,
      target_tier: "business",
    });
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_srv",
      code_url: "weixin://wxpay/bizpayurl?pr=srv",
      plan_id: "business",
      period: "1m",
      duration_days: 30,
      months: 1,
      // 服务端最终扣的又比报价少一点（用户在结账页停留期间余额涨了）——
      // 二维码那行也得跟着服务端走，不能拿报价或本地预览凑。
      amount_credits: 30_000_000,
      amount_cents: 21600,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    // 选择页那个数字是预览价，明确写成「下一步 · 约 $200」。
    expect(await screen.findByText("下一步 · 约 $200")).toBeTruthy();
    await userEvent.click(screen.getByText("下一步 · 约 $200"));

    // 结账页：服务端报价，不是本地的 $200。
    expect(await screen.findByText(/^微信支付 \$37\.50$/)).toBeTruthy();
    await userEvent.click(screen.getByText(/^微信支付 \$37\.50$/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());

    // 二维码页：下单响应里的 amount_credits，不是报价也不是本地预览。
    expect(await screen.findByText(/\$30$/)).toBeTruthy();
  });
});

// 加了 grant 角色之后账号屏分两块。平铺的话用户分不清哪张是「我的档位」、
// 哪张是临时补的加量包，点「换档」时不知道会换掉哪一个。
describe("LlmGatewaySubscriptionDock 账号屏分组", () => {
  function seedPlans(plans: unknown[], extra: Record<string, unknown> = {}) {
    seedLoggedOutOfPlan();
    const login = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
    login.subscription = {
      active: true,
      tier: "pro",
      usage_micros_per_5h: 140_000_000,
      usage_micros_per_week: 700_000_000,
      valid_until: "2099-01-01T00:00:00Z",
      plans,
      ...extra,
    };
    localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  }

  const subPlan = {
    grant_id: "g_pro",
    tier: "pro",
    role: "subscription",
    usage_micros_per_5h: 100_000_000,
    usage_micros_per_week: 500_000_000,
    valid_from: "2026-07-01T00:00:00Z",
    valid_until: "2026-07-31T00:00:00Z",
  };

  it("单订阅无加量包：只渲染「我的套餐」块", async () => {
    seedPlans([subPlan]);
    renderDock();

    expect(await screen.findByText("我的套餐")).toBeTruthy();
    // 大多数用户不会买加量包，不该给他们一个空标题。
    expect(screen.queryByText("额外额度")).toBeNull();
  });

  it("订阅 + 2 个加量包：两块都渲染，加量包按服务端顺序显示", async () => {
    seedPlans([
      subPlan,
      {
        grant_id: "g_x1",
        tier: "extra",
        role: "extra",
        usage_micros_per_5h: 20_000_000,
        usage_micros_per_week: 100_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-08T00:00:00Z",
      },
      {
        grant_id: "g_x2",
        tier: "extra",
        role: "extra",
        usage_micros_per_5h: 40_000_000,
        usage_micros_per_week: 200_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-20T00:00:00Z",
      },
    ]);
    renderDock();

    expect(await screen.findByText("我的套餐")).toBeTruthy();
    expect(screen.getByText("额外额度")).toBeTruthy();
    // 服务端已按 valid_until 排好，客户端不重排 —— 那个顺序表达的是
    // 「先扣哪一层」。
    const quotas = screen
      .getAllByText(/× Starter 用量$/)
      .map((el) => el.textContent ?? "");
    expect(quotas).toEqual([
      "5× Starter 用量",
      "1× Starter 用量",
      "2× Starter 用量",
    ]);
  });

  it("有排队中的套餐时显示切换提示行", async () => {
    seedPlans([
      subPlan,
      {
        grant_id: "g_queued",
        tier: "starter",
        role: "subscription",
        usage_micros_per_5h: 20_000_000,
        usage_micros_per_week: 100_000_000,
        valid_from: "2026-07-31T00:00:00Z",
        valid_until: "2026-08-30T00:00:00Z",
        pending: true,
      },
    ]);
    renderDock();

    // 降档是排队生效的，用户必须看得到「换的是哪一档、什么时候换」。
    expect(await screen.findByText(/到期后自动切换到 \$20/)).toBeTruthy();
  });

  // 额外额度的描述有三级回落：title > extra 的倍数 > custom 的档位名。
  // 三条一起测，因为它们是同一个函数的三个分支，分开写会让「谁顶替谁」看不出来。
  it("额外额度描述：有 title 用 title，没有则回落到倍数/专属额度", async () => {
    seedPlans([
      subPlan,
      {
        grant_id: "g_gift",
        tier: "custom",
        role: "extra",
        title: "新春回馈",
        usage_micros_per_5h: 37_000_000,
        usage_micros_per_week: 412_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-20T00:00:00Z",
      },
      {
        grant_id: "g_gift2",
        tier: "custom",
        role: "extra",
        usage_micros_per_5h: 37_000_000,
        usage_micros_per_week: 412_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-21T00:00:00Z",
      },
      {
        grant_id: "g_x1",
        tier: "extra",
        role: "extra",
        usage_micros_per_5h: 40_000_000,
        usage_micros_per_week: 200_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-22T00:00:00Z",
      },
    ]);
    renderDock();

    // (a) title 顶替额度描述。
    expect(await screen.findByText("新春回馈")).toBeTruthy();
    // (b) 无 title 的 custom 只剩档位名 —— 5h/周互不成比例，算不出干净的倍数。
    expect(screen.getAllByText("专属额度").length).toBe(2);
    // (c) 无 title 的真加量包按单位数换算成 Starter 倍数。
    expect(screen.getByText("2× Starter 用量")).toBeTruthy();
    // 礼物的额度绝不能泄露成金额。
    expect(screen.queryByText(/\$37/)).toBeNull();
  });

  it("顶部额度上限仍是总和，并标明含加量包", async () => {
    seedPlans([
      subPlan,
      {
        grant_id: "g_x1",
        tier: "extra",
        role: "extra",
        usage_micros_per_5h: 40_000_000,
        usage_micros_per_week: 200_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-20T00:00:00Z",
      },
    ]);
    renderDock();

    // 只显示订阅层自己的 5× 是错的 —— 实际卡用户的是 7× 这个总和。
    expect(
      await screen.findByText(/总用量 7× Starter（含额外额度）/),
    ).toBeTruthy();
  });

  it("订阅已过期但仍有加量包：加量包正常显示，购买入口置灰并给出原因", async () => {
    // 服务端规定加量包必须有生效的**订阅层**才能买；只有加量包时必须拒绝，
    // 否则加量包能给自己续命，那道门槛就形同虚设。
    seedPlans([
      {
        grant_id: "g_x1",
        tier: "extra",
        role: "extra",
        usage_micros_per_5h: 40_000_000,
        usage_micros_per_week: 200_000_000,
        valid_from: "2026-07-01T00:00:00Z",
        valid_until: "2026-07-20T00:00:00Z",
      },
    ]);
    renderDock();

    // 已买的加量包继续供额度到它自己的到期日 —— 不隐藏、不标失效。
    expect(await screen.findByText("额外额度")).toBeTruthy();
    expect(screen.getByText("2× Starter 用量")).toBeTruthy();
    // 置灰而不是隐藏：手上还有加量包在跑却找不到再买一个的地方，会以为是 bug。
    expect(
      screen.getByText(/需要有生效的套餐才能购买加量包/),
    ).toBeInTheDocument();
  });

  it("老服务端（无 role）：所有套餐落在「我的套餐」块，不崩不空白", async () => {
    const { role: _dropped, ...legacy } = subPlan;
    seedPlans([
      legacy,
      {
        ...legacy,
        grant_id: "g_starter",
        tier: "starter",
        usage_micros_per_5h: 20_000_000,
        usage_micros_per_week: 100_000_000,
      },
    ]);
    renderDock();

    expect(await screen.findByText("我的套餐")).toBeTruthy();
    expect(screen.getByText("5× Starter 用量")).toBeTruthy();
    expect(screen.getByText("Starter · 适合大部分普通用户")).toBeTruthy();
    // 空的额外额度块比平铺更糟：它在暗示用户少了点什么。
    expect(screen.queryByText("额外额度")).toBeNull();
  });
});

// 兑换码是发给特定用户的，只能用一次。这些 case 盯两件事：兑换成功后要
// 立刻反映到账户页，以及三种失败必须给出各自的原因 —— 尤其「不属于当前
// 账号」，笼统说「无效」会让有多个账号的人反复重试同一个正确的码。
describe("LlmGatewaySubscriptionDock 兑换码", () => {
  async function openRedeemScreen() {
    renderDock();
    await userEvent.click(await screen.findByText("使用兑换码"));
    return screen.findByPlaceholderText("ABCDE-FGHJK");
  }

  it("兑换成功后刷新订阅并回到账户页", async () => {
    seedActivePlan();
    const redeem = vi.spyOn(gateway, "redeemPromoCode").mockResolvedValue({
      subscription: { active: true, tier: "pro" },
    });
    const refresh = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockResolvedValue(serverSaysActive());

    const input = await openRedeemScreen();
    await userEvent.type(input, "ABCDE-FGHJK");
    await userEvent.click(screen.getByRole("button", { name: "兑换" }));

    await waitFor(() => expect(redeem).toHaveBeenCalledWith("ABCDE-FGHJK"));
    // 兑换出来的套餐必须立刻可见，否则用户以为没生效又去点一次。
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("兑换成功，套餐已开通"),
    );
  });

  it("输入自动转大写，用户不必自己切键盘", async () => {
    seedActivePlan();
    const input = (await openRedeemScreen()) as HTMLInputElement;
    await userEvent.type(input, "abcde-fghjk");
    expect(input.value).toBe("ABCDE-FGHJK");
  });

  it.each([
    ["promo_code_not_found", "兑换码无效"],
    ["promo_code_not_yours", "此兑换码不属于当前账号"],
    ["promo_code_already_redeemed", "此兑换码已被使用"],
  ])("错误码 %s 给出对应提示", async (code, message) => {
    seedActivePlan();
    vi.spyOn(gateway, "redeemPromoCode").mockRejectedValue(
      new GatewayApiError(code === "promo_code_not_found" ? 404 : 403, code),
    );

    const input = await openRedeemScreen();
    await userEvent.type(input, "ABCDE-FGHJK");
    await userEvent.click(screen.getByRole("button", { name: "兑换" }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(message));
  });

  it("空输入时兑换按钮不可点", async () => {
    seedActivePlan();
    await openRedeemScreen();
    expect(screen.getByRole("button", { name: "兑换" })).toBeDisabled();
  });
});

// 新旧版本错配。fwai_app 的发布版本和网关分开部署，线上同时存在多个客户端
// 版本。这些 case 测的是「不崩、不卡死、不出现空块」，不是体验好坏。
describe("LlmGatewaySubscriptionDock 新端连老网关", () => {
  /** 老网关：没有 quote 端点，也不返回 grant 的 role。 */
  function seedOldGateway() {
    seedLoggedOutOfPlan();
    const login = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
    login.subscription = {
      active: true,
      tier: "pro",
      usage_micros_per_5h: 100_000_000,
      usage_micros_per_week: 500_000_000,
      valid_until: "2099-01-01T00:00:00Z",
      plans: [
        {
          grant_id: "g_pro",
          tier: "pro",
          usage_micros_per_5h: 100_000_000,
          usage_micros_per_week: 500_000_000,
          valid_from: "2026-07-01T00:00:00Z",
          valid_until: "2099-01-01T00:00:00Z",
        },
      ],
    };
    localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    return vi
      .spyOn(gateway, "fetchPlanQuote")
      .mockRejectedValue(new GatewayApiError(404, "not_found"));
  }

  it("role 缺失时所有套餐落在「我的套餐」，不渲染空的加量包块", async () => {
    seedOldGateway();
    renderDock();

    expect(await screen.findByText("我的套餐")).toBeTruthy();
    expect(screen.getByText("5× Starter 用量")).toBeTruthy();
    // 空标题比没有标题更让人困惑：用户会以为额外额度没加载出来。
    expect(screen.queryByText("额外额度")).toBeNull();
  });

  it("404 之后换档 UI 全部收起，购买流程仍可用", async () => {
    seedOldGateway();
    const createOrder = vi.spyOn(gateway, "createPlanOrder").mockResolvedValue({
      order_id: "pay_old",
      code_url: "weixin://wxpay/bizpayurl?pr=old",
      plan_id: "pro",
      period: "1m",
      duration_days: 30,
      months: 1,
      amount_credits: 100_000_000,
      amount_cents: 72000,
      exchange_rate: 7.2,
      currency: "CNY",
    } as Awaited<ReturnType<typeof gateway.createPlanOrder>>);

    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$100"));
    await userEvent.click(await screen.findByText(/^下一步/));

    // 探测是惰性的：第一次拉报价拿到 404 才知道，那一次直接退回旧流程下单。
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(await screen.findByText("微信扫码支付")).toBeTruthy();
    expect(screen.queryByText("确认订单")).toBeNull();

    // 知道之后就不再问意图了——老网关不认 as_extra，选加量包只会买到一份
    // 并行叠加的普通套餐。
    await userEvent.click(await screen.findByText("取消"));
    await userEvent.click(await screen.findByText("返回"));
    await userEvent.click(await screen.findByText("购买套餐"));
    expect(await screen.findByText("选择套餐 · 微信支付")).toBeTruthy();
    expect(screen.queryByText("购买加量包")).toBeNull();
    expect(screen.queryByText("换档")).toBeNull();
  });
});

// 四种 action 的结账页文案。选错分支意味着用户对「点下去会发生什么」的预期
// 是错的——尤其 queue 那条：钱要等下个周期才买到东西。
describe("LlmGatewaySubscriptionDock 四种 action 的文案", () => {
  async function checkoutWith(patch: Partial<gateway.GatewayPlanQuote>) {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    mockQuote(patch);
    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("$200"));
    await userEvent.click(await screen.findByText(/^下一步/));
  }

  it.each([
    ["upgrade_now", /立即升级到 \$200/],
    ["queue", /自动切换到 \$200/],
    ["activate_now", /立即生效：\$200/],
  ] as const)("%s 的主文案", async (action, pattern) => {
    await checkoutWith({ action, target_tier: "business" });
    expect(await screen.findByText(pattern)).toBeTruthy();
    // 四个数字任何一种 action 下都得在。
    expect(screen.getByText("余额抵扣")).toBeTruthy();
    expect(screen.getByText("剩余余额")).toBeTruthy();
    expect(screen.getByText("实付")).toBeTruthy();
  });

  it("extra 说的是叠加而不是换档", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    mockQuote({ action: "extra", target_tier: "extra" });
    renderDock();
    await userEvent.click(await screen.findByText("购买套餐"));
    await userEvent.click(await screen.findByText("购买加量包"));
    await userEvent.click(await screen.findByText(/^下一步/));

    expect(
      await screen.findByText(/加量包立即生效，与当前套餐额度叠加/),
    ).toBeTruthy();
    // 加量包不动订阅层，不该出现排队那条不退款的警告。
    expect(screen.queryByText(/此操作不退款/)).toBeNull();
  });
});

// 服务端说这个客户端版本太老（X-Client-Upgrade: required）。挡的**只有购买**
// —— 老版本转发 AI 流量是正常的，把整个客户端锁死会造成一批用户既用不了也不
// 知道为什么，而他们的订阅还在计费。
describe("LlmGatewaySubscriptionDock 版本过旧", () => {
  it("挡住购买入口并说明原因", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    const createOrder = vi.spyOn(gateway, "createPlanOrder");
    recordUpgradeSignal("required");
    renderDock();

    const buy = await screen.findByText("购买套餐");
    expect(buy.closest("button")!.disabled).toBe(true);
    expect(await screen.findByText(/当前版本过旧/)).toBeTruthy();

    await userEvent.click(buy);
    expect(screen.queryByText("选择套餐 · 微信支付")).toBeNull();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("转发和其它功能不受影响", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    recordUpgradeSignal("required");
    renderDock();

    // 这才是老版本用户真正在做的事，买不了套餐不该连活都干不了。
    await userEvent.click(await startButton());
    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalled(),
    );
  });

  it("suggest 不挡任何东西", async () => {
    seedActivePlan();
    vi.spyOn(gateway, "fetchGatewaySubscription").mockResolvedValue(
      serverSaysActive(),
    );
    recordUpgradeSignal("suggest");
    renderDock();

    const buy = await screen.findByText("购买套餐");
    expect(buy.closest("button")!.disabled).toBe(false);
    expect(screen.queryByText(/当前版本过旧/)).toBeNull();
  });
});
