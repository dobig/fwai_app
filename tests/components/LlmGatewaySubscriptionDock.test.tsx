import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmGatewaySubscriptionDock } from "@/components/llm-gateway/LlmGatewaySubscriptionDock";
import * as gateway from "@/lib/api/llm-gateway";
import { GatewayApiError } from "@/lib/api/llm-gateway";
import { providersApi } from "@/lib/api";

// 这些 case 全部围绕一个问题：本地缓存的 subscription 是登录那一刻的快照，
// 管理员在后台开通套餐不经过客户端。凡是拿 isActive 挡住用户的地方，都必须先
// 跟服务端对一次账。
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
});

describe("LlmGatewaySubscriptionDock 开启转发", () => {
  it("缓存说未开通、服务端说已开通时，直接开启转发而不是催购买", async () => {
    seedLoggedOutOfPlan();
    const fetchSub = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockResolvedValue(serverSaysActive());

    render(<LlmGatewaySubscriptionDock />);
    await userEvent.click(await screen.findByText("开启转发"));

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

    render(<LlmGatewaySubscriptionDock />);
    await userEvent.click(await screen.findByText("开启转发"));

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

    render(<LlmGatewaySubscriptionDock />);
    await userEvent.click(await screen.findByText("开启转发"));

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

    render(<LlmGatewaySubscriptionDock />);
    await userEvent.click(await screen.findByText("开启转发"));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchSub).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(providersApi.startForwarding).toHaveBeenCalled(),
    );
  });
});

describe("LlmGatewaySubscriptionDock 购买套餐", () => {
  it("进购买屏前先对账，已开通的人看得到当前套餐而不是空白", async () => {
    seedLoggedOutOfPlan();
    const fetchSub = vi
      .spyOn(gateway, "fetchGatewaySubscription")
      .mockResolvedValue(serverSaysActive());

    render(<LlmGatewaySubscriptionDock />);
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

    render(<LlmGatewaySubscriptionDock />);
    await userEvent.click(await screen.findByText("购买套餐"));

    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledWith("购买前请先验证邮箱"),
    );
  });
});
