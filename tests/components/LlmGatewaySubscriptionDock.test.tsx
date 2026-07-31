import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { LlmGatewaySubscriptionDock } from "@/components/llm-gateway/LlmGatewaySubscriptionDock";
import {
  ActiveAppProvider,
  useActiveApp,
} from "@/components/active-app-provider";
import * as gateway from "@/lib/api/llm-gateway";
import { GatewayApiError } from "@/lib/api/llm-gateway";
import { providersApi, type AppId } from "@/lib/api";
import { createTestQueryClient } from "../utils/testQueryClient";

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
// 下单时「叠加还是排队」的选择必须真的传到服务端。
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

  it("账户页逐个列出持有的套餐，并标出待生效的那个", async () => {
    seedStackedPlans();
    renderDock();

    // 三个套餐都看得到，不是只显示最贵的那个。
    expect(await screen.findByText("$10/5h")).toBeTruthy();
    expect(screen.getAllByText("$100/5h").length).toBe(2);
    // 排队中的那个要明确标出来，否则用户以为额度已经到账了。
    expect(screen.getByText("待生效")).toBeTruthy();
  });

  it("只有一个套餐时退回单行有效期，不显示列表", async () => {
    seedLoggedOutOfPlan();
    const login = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
    login.subscription = {
      active: true,
      tier: "pro",
      valid_until: "2026-07-31T00:00:00Z",
      plans: [
        {
          grant_id: "g_pro",
          tier: "pro",
          usage_micros_per_5h: 100_000_000,
          usage_micros_per_week: 500_000_000,
          valid_from: "2026-07-01T00:00:00Z",
          valid_until: "2026-07-31T00:00:00Z",
        },
      ],
    };
    localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
    renderDock();

    expect(await screen.findByText(/有效期至/)).toBeTruthy();
    expect(screen.queryByText("$100/5h")).toBeNull();
  });

  it("默认排队续费，选「立即叠加」才并行生效", async () => {
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
    await userEvent.click(await screen.findByText("$100"));

    // 默认是「到期后生效」——选错方向的代价不对称：想续命买成并行的话，
    // 那份额度会跟着套餐一起作废。
    await userEvent.click(await screen.findByText(/^微信支付/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(createOrder.mock.calls[0][3]).toBe(true);

    // 改选叠加后必须真的把 false 传下去，否则用户买到的不是他选的东西。
    // 下单后停在二维码页，得先取消才能回到选项。
    createOrder.mockClear();
    await userEvent.click(await screen.findByText("取消"));
    await userEvent.click(await screen.findByText("立即叠加"));
    await userEvent.click(screen.getByText(/^微信支付/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(createOrder.mock.calls[0][3]).toBe(false);
  });

  it("没有生效套餐时不问排队，直接从现在起算", async () => {
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
    await userEvent.click(await screen.findByText("$100"));

    // 无套餐时没有这个选项可选。
    expect(screen.queryByText("立即叠加")).toBeNull();
    await userEvent.click(await screen.findByText(/^微信支付/));
    await waitFor(() => expect(createOrder).toHaveBeenCalled());
    expect(createOrder.mock.calls[0][3]).toBe(false);
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
