import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayUsagePoller,
  USAGE_REFRESH_INTERVAL_MS,
  USAGE_RETRY_AFTER_FAILURE_MS,
} from "@/components/GatewayUsagePoller";
import * as gateway from "@/lib/api/llm-gateway";

// 登录后后台定时刷新用量：网关靠这些带 X-Client-Version 的请求知道每台设备
// 当前的版本，App 缩在托盘里时也一样。
const USAGE: gateway.GatewayUsage = {
  five_hour: { utilization: 12 },
  seven_day: { utilization: 34 },
} as gateway.GatewayUsage;

function signIn(token = "tok_a") {
  gateway.saveGatewayTokens({
    token_type: "Bearer",
    access_token: token,
    expires_in: 0,
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewayUsagePoller", () => {
  it("does nothing while signed out", async () => {
    const fetch = vi.spyOn(gateway, "fetchGatewayUsage");
    render(<GatewayUsagePoller />);
    await advance(USAGE_REFRESH_INTERVAL_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes at once on start, caches it and tells the dock", async () => {
    signIn();
    const fetch = vi
      .spyOn(gateway, "fetchGatewayUsage")
      .mockResolvedValue(USAGE);
    const changed = vi.fn();
    window.addEventListener(gateway.GATEWAY_USAGE_CHANGED_EVENT, changed);
    render(<GatewayUsagePoller />);
    await flush();
    window.removeEventListener(gateway.GATEWAY_USAGE_CHANGED_EVENT, changed);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gateway.loadGatewayUsageCache()?.usage).toEqual(USAGE);
    expect(changed).toHaveBeenCalled();
  });

  it("refreshes every twenty minutes, counted from the last fetch", async () => {
    signIn();
    // 面板刚拉过：启动时不重复拉。
    gateway.saveGatewayUsageCache(USAGE);
    const fetch = vi
      .spyOn(gateway, "fetchGatewayUsage")
      .mockResolvedValue(USAGE);
    render(<GatewayUsagePoller />);
    await flush();
    expect(fetch).not.toHaveBeenCalled();

    await advance(USAGE_REFRESH_INTERVAL_MS - 60_000);
    expect(fetch).not.toHaveBeenCalled();
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(USAGE_REFRESH_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failure instead of retrying every minute", async () => {
    signIn();
    const fetch = vi
      .spyOn(gateway, "fetchGatewayUsage")
      .mockRejectedValue(new Error("offline"));
    render(<GatewayUsagePoller />);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    await advance(USAGE_RETRY_AFTER_FAILURE_MS - 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("catches up when the window comes back", async () => {
    signIn();
    gateway.saveGatewayUsageCache(USAGE);
    const fetch = vi
      .spyOn(gateway, "fetchGatewayUsage")
      .mockResolvedValue(USAGE);
    render(<GatewayUsagePoller />);
    await flush();
    expect(fetch).not.toHaveBeenCalled();

    // 隐藏期间系统停掉了定时器：缓存已经过期，一次 tick 都没跑。
    vi.setSystemTime(Date.now() + USAGE_REFRESH_INTERVAL_MS);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops a result that arrives after the account changed", async () => {
    signIn("tok_a");
    let resolve!: (u: gateway.GatewayUsage) => void;
    vi.spyOn(gateway, "fetchGatewayUsage").mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<GatewayUsagePoller />);
    await flush();
    signIn("tok_b");
    await act(async () => {
      resolve(USAGE);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gateway.loadGatewayUsageCache()).toBeNull();
  });
});
