import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatTokenCount,
  GatewayAccountSettings,
} from "@/components/settings/GatewayAccountSettings";
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
  // 默认没有节省数据；需要的用例自己覆盖。
  vi.spyOn(gateway, "fetchTokensSaved").mockRejectedValue(
    new GatewayApiError(404, "not found"),
  );
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

  it("开关打开时显示累计节省的 token", async () => {
    seedLogin(false, true);
    const fetch = vi
      .spyOn(gateway, "fetchTokensSaved")
      .mockResolvedValue(1_234_567);
    render(<GatewayAccountSettings />);

    expect(await screen.findByText("123 万")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("开关关闭时不拉也不显示节省量", () => {
    seedLogin(false, false);
    const fetch = vi.spyOn(gateway, "fetchTokensSaved").mockResolvedValue(99);
    render(<GatewayAccountSettings />);

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/已为你节省/)).not.toBeInTheDocument();
  });

  it("从关到开后拉取并显示节省量，再关掉就隐藏", async () => {
    seedLogin(false, false);
    const fetch = vi.spyOn(gateway, "fetchTokensSaved").mockResolvedValue(800);
    const profile = (on: boolean) => ({
      id: "user_1",
      username: "tester",
      email: "tester@example.com",
      role: "user" as const,
      email_verified: true,
      redact_secrets: false,
      tool_compression: on,
    });
    const set = vi
      .spyOn(gateway, "setToolCompression")
      .mockResolvedValueOnce(profile(true))
      .mockResolvedValueOnce(profile(false));
    render(<GatewayAccountSettings />);

    await userEvent.click(compressToggle());
    expect(await screen.findByText(/已为你节省/)).toBeTruthy();
    expect(screen.getByText("800")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    await userEvent.click(compressToggle());
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/已为你节省/)).not.toBeInTheDocument(),
    );
  });

  it("老服务端没有节省接口时不显示这一行", async () => {
    seedLogin(false, true);
    render(<GatewayAccountSettings />);
    await waitFor(() => expect(gateway.fetchTokensSaved).toHaveBeenCalled());
    expect(screen.queryByText(/已为你节省/)).not.toBeInTheDocument();
  });
});

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [9_999, "9999"],
    [10_000, "1 万"],
    [1_234_567, "123 万"],
    [56_789, "5.7 万"],
    [12_345_678, "1235 万"],
    [250_000_000, "2.5 亿"],
  ])("%d → %s", (n, want) => {
    expect(formatTokenCount(n)).toBe(want);
  });
});
