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

// 切 app 的入口。用真的 context 而不是重挂组件——「切走要还原」正是靠
// activeApp 变化触发的，重挂就测不到那条路径。
function SwitchTo({ app }: { app: AppId }) {
  const { setActiveApp } = useActiveApp();
  return <button onClick={() => setActiveApp(app)}>切到 {app}</button>;
}

function renderDock(activeApp: AppId = "claude", switchTo?: AppId) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ActiveAppProvider initialApp={activeApp}>
        {switchTo && <SwitchTo app={switchTo} />}
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
  vi.spyOn(providersApi, "stopForwarding").mockResolvedValue(undefined as never);
  vi.spyOn(providersApi, "removeManaged").mockResolvedValue(true);
  vi.spyOn(providersApi, "updateTrayMenu").mockResolvedValue(undefined as never);
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

// 切走了却不还原，用户的 settings.json 会一直压着网关的 endpoint，而面板显示的
// 是另一个 app 的状态——配置被改了却没有任何入口能关掉它。
describe("LlmGatewaySubscriptionDock 切换 app", () => {
  it("切到别的 CLI 时把上一个还原回去", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockResolvedValue(true);

    renderDock("claude", "codex");
    // 等首次状态读完，否则 toast 的判断依据（缓存）还是空的。
    await screen.findByText(/^结束转发/);

    await userEvent.click(screen.getByText("切到 codex"));

    await waitFor(() =>
      expect(providersApi.stopForwarding).toHaveBeenCalledWith("claude"),
    );
    expect(toasts.info).toHaveBeenCalledWith(
      "已切换到 Codex，Claude Code 的转发已结束并还原配置",
    );
    // 只停旧，不自动开新——切个标签就往磁盘写网关凭据太吓人了。
    expect(providersApi.startForwarding).not.toHaveBeenCalled();
  });

  it("上一个本来就没转发时不弹提示，但仍然调一次还原（空操作）", async () => {
    seedActivePlan();
    vi.mocked(providersApi.isForwarding).mockResolvedValue(false);

    renderDock("claude", "codex");
    await startButton();

    await userEvent.click(screen.getByText("切到 codex"));

    // 无条件调：客户端缓存可能是陈旧的（上次会话崩了留下备份），
    // 漏还原的代价比多调一次空操作大得多。
    await waitFor(() =>
      expect(providersApi.stopForwarding).toHaveBeenCalledWith("claude"),
    );
    expect(toasts.info).not.toHaveBeenCalledWith(
      expect.stringContaining("的转发已结束"),
    );
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
