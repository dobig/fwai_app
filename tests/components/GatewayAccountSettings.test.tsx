import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayAccountSettings } from "@/components/settings/GatewayAccountSettings";
import * as gateway from "@/lib/api/llm-gateway";
import { GatewayApiError } from "@/lib/api/llm-gateway";

// 「发送前隐藏密钥」现在放在应用设置页（左上角齿轮）里。它和右下角网关面板共用
// 同一份缓存的登录信息：一边改了，另一边要跟着变。
const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

const LOGIN_KEY = "llm-gateway-login";

function seedLogin(redact = false, compress = false) {
  const login: gateway.GatewayLoginResult = {
    token_type: "Bearer",
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 0,
    user: {
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user",
      email_verified: true,
      redact_secrets: redact,
      tool_compression: compress,
    },
    account: { id: "acct_1" },
    subscription: { active: true, tier: "pro" },
  };
  gateway.saveGatewayLogin(login);
}

const toggle = () => screen.getByRole("switch", { name: "发送前隐藏密钥" });
const compressToggle = () =>
  screen.getByRole("switch", { name: "压缩工具输出" });

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  toasts.error.mockClear();
  toasts.success.mockClear();
});

describe("GatewayAccountSettings", () => {
  it("没登录网关时不显示开关，只提示去哪里登录", () => {
    render(<GatewayAccountSettings />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/登录 llm_gateway 后可在这里设置/)).toBeTruthy();
  });

  it("开启后以服务端返回的资料为准回写缓存", async () => {
    seedLogin(false);
    const set = vi.spyOn(gateway, "setSecretRedaction").mockResolvedValue({
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user",
      email_verified: true,
      redact_secrets: true,
    });
    render(<GatewayAccountSettings />);

    expect(toggle()).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle());

    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(toggle()).toHaveAttribute("aria-checked", "true"),
    );
    expect(toasts.success).toHaveBeenCalledWith("已开启发送前隐藏密钥");
    expect(
      JSON.parse(localStorage.getItem(LOGIN_KEY)!).user.redact_secrets,
    ).toBe(true);
  });

  it("服务端拒绝时开关不动，并提示失败", async () => {
    seedLogin(false);
    vi.spyOn(gateway, "setSecretRedaction").mockRejectedValue(
      new GatewayApiError(500, "boom"),
    );
    render(<GatewayAccountSettings />);

    await userEvent.click(toggle());

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("设置失败，请稍后重试"),
    );
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(
      JSON.parse(localStorage.getItem(LOGIN_KEY)!).user.redact_secrets,
    ).toBe(false);
  });

  it("在网关面板里登录、登出后开关跟着出现和消失", () => {
    render(<GatewayAccountSettings />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    act(() => seedLogin(true));
    expect(toggle()).toHaveAttribute("aria-checked", "true");

    act(() => gateway.clearGatewayLogin());
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("压缩工具输出默认关闭，开启后回写缓存，且不动隐藏密钥", async () => {
    seedLogin(true, false);
    const set = vi.spyOn(gateway, "setToolCompression").mockResolvedValue({
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user",
      email_verified: true,
      redact_secrets: true,
      tool_compression: true,
    });
    const redact = vi.spyOn(gateway, "setSecretRedaction");
    render(<GatewayAccountSettings />);

    expect(compressToggle()).toHaveAttribute("aria-checked", "false");
    await userEvent.click(compressToggle());

    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(compressToggle()).toHaveAttribute("aria-checked", "true"),
    );
    expect(redact).not.toHaveBeenCalled();
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    expect(toasts.success).toHaveBeenCalledWith("已开启压缩工具输出");
    expect(
      JSON.parse(localStorage.getItem(LOGIN_KEY)!).user.tool_compression,
    ).toBe(true);
  });

  it("老服务端不返回 tool_compression 时当作未开启", () => {
    seedLogin();
    const cached = JSON.parse(localStorage.getItem(LOGIN_KEY)!);
    delete cached.user.tool_compression;
    localStorage.setItem(LOGIN_KEY, JSON.stringify(cached));
    render(<GatewayAccountSettings />);
    expect(compressToggle()).toHaveAttribute("aria-checked", "false");
  });
});
