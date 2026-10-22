import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMinVersion,
  getForceUpgrade,
  isBelowVersion,
  isUpgradeLocked,
  parseVersion,
  resetForceUpgrade,
} from "@/lib/forceUpgrade";
import { APP_VERSION } from "@/lib/clientUpgrade";
import {
  fetchGatewayClientVersion,
  fetchGatewaySubscription,
} from "@/lib/api/llm-gateway";
import { providersApi } from "@/lib/api";
import {
  GATEWAY_TOGGLE_FORWARDING_EVENT,
  requestToggleForwarding,
} from "@/lib/apps";

// 强制升级的判定和锁：以 /v1/client-version 为准，426 直接锁；锁住以后转发
// 开关请求一律吞掉。

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// 比当前版本高一个 minor，测试不用跟着 package.json 改。
function nextMinor(): string {
  const [major, minor] = parseVersion(APP_VERSION)!;
  return `${major}.${minor + 1}.0`;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("llm-gateway-base-url", "https://gw.test");
  resetForceUpgrade();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("version comparison", () => {
  it("compares numerically and tolerates prefixes and suffixes", () => {
    expect(isBelowVersion("1.9.0", "1.10.0")).toBe(true);
    expect(isBelowVersion("1.10.0", "1.9.0")).toBe(false);
    expect(isBelowVersion("1.9.0", "1.9.0")).toBe(false);
    expect(isBelowVersion("1.9", "1.9.1")).toBe(true);
    expect(isBelowVersion("v1.9.0-beta.1", "1.9.1")).toBe(true);
    expect(isBelowVersion("2.0.0+sha", "1.99.99")).toBe(false);
  });

  it("never locks on a version it cannot read", () => {
    expect(isBelowVersion("garbage", "1.0.0")).toBe(false);
    expect(isBelowVersion("1.0.0", "1.x")).toBe(false);
    expect(parseVersion("1.2.3.4")).toBeNull();
  });
});

describe("lock state", () => {
  it("locks below the minimum and unlocks when the minimum is lowered", () => {
    applyMinVersion(nextMinor());
    expect(getForceUpgrade()).toEqual({ minVersion: nextMinor() });

    applyMinVersion(APP_VERSION);
    expect(isUpgradeLocked()).toBe(false);

    applyMinVersion(nextMinor());
    applyMinVersion("");
    expect(isUpgradeLocked()).toBe(false);
  });

  it("locks on a 426 from any gateway request, with the server's minimum", async () => {
    mockFetch(426, { error: "client_upgrade_required", min_version: "9.0.0" });
    await expect(fetchGatewaySubscription()).rejects.toMatchObject({
      status: 426,
      code: "client_upgrade_required",
    });
    expect(getForceUpgrade()).toEqual({ minVersion: "9.0.0" });
  });

  it("ignores other errors", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(fetchGatewaySubscription()).rejects.toBeTruthy();
    expect(isUpgradeLocked()).toBe(false);
  });
});

describe("fetchGatewayClientVersion", () => {
  it("calls the public endpoint without a token and normalizes the body", async () => {
    localStorage.setItem(
      "llm-gateway-oauth",
      JSON.stringify({ access_token: "access-token" }),
    );
    const fetchMock = mockFetch(200, { min_version: "1.10.0" });

    await expect(fetchGatewayClientVersion()).resolves.toEqual({
      min_version: "1.10.0",
      suggest_version: "",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.test/v1/client-version");
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });
});

describe("requestToggleForwarding while locked", () => {
  it("swallows the request and rebuilds the tray", () => {
    const tray = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockResolvedValue(true);
    const listener = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, listener);
    try {
      expect(requestToggleForwarding("claude")).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);

      applyMinVersion(nextMinor());
      expect(requestToggleForwarding("claude")).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(tray).toHaveBeenCalled();
    } finally {
      window.removeEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, listener);
    }
  });
});
