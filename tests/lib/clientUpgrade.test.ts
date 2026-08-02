import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APP_VERSION,
  CLIENT_VERSION_VALUE,
  getUpgradeSignal,
  recordUpgradeSignal,
  resetUpgradeSignal,
} from "@/lib/clientUpgrade";
import { fetchGatewaySubscription } from "@/lib/api/llm-gateway";
import pkg from "../../package.json";

// 版本上报和升级提示。这些 case 盯的是两件事：
// 1. 版本号真的来自 package.json（写死常量正是这个 bug 的成因）。
// 2. 升级信号不会被后续响应悄悄撤掉——挡住的购买入口不能时灵时不灵。

const BASE_URL_KEY = "llm-gateway-base-url";

let captured: RequestInit[] = [];

function mockFetch(headers: Record<string, string> = {}) {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      captured.push(init);
      return new Response(JSON.stringify({ active: false }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }),
  );
}

function sentHeader(name: string): string | undefined {
  return (captured[0].headers as Record<string, string>)[name];
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BASE_URL_KEY, "https://gw.test");
  resetUpgradeSignal();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clientUpgrade 版本上报", () => {
  it("版本号取自 package.json，不是手写常量", () => {
    // 手写常量迟早会忘记更新——上一版的 app_version 在代码里躺了几十个版本
    // 一直是同一个字符串。这条断言就是防它复发的那道闸。
    expect(APP_VERSION).toBe(pkg.version);
    expect(CLIENT_VERSION_VALUE).toBe(`fwai_app/${pkg.version}`);
  });

  it("每个 gateway 请求都带 X-Client-Version", async () => {
    mockFetch();
    await fetchGatewaySubscription();
    // 头在 gatewayRequest 里统一注入，所以随便挑一个端点都该有。
    expect(sentHeader("X-Client-Version")).toBe(`fwai_app/${pkg.version}`);
  });
});

describe("clientUpgrade 升级信号", () => {
  it("响应带 suggest / required 时记下来", async () => {
    mockFetch({ "X-Client-Upgrade": "suggest" });
    await fetchGatewaySubscription();
    expect(getUpgradeSignal()).toBe("suggest");
  });

  it("没有该头时什么都不做", async () => {
    mockFetch();
    await fetchGatewaySubscription();
    // 老网关不发这个头，不能被解读成「没有更新」。
    expect(getUpgradeSignal()).toBeNull();
  });

  it("required 不会被后续响应降级回去", () => {
    recordUpgradeSignal("required");
    // 响应头是逐个请求发的，中间任何一次没带（打到尚未更新的实例、或走了
    // 不校验版本的端点）都不该让已经挡住的购买入口重新放开。
    recordUpgradeSignal("suggest");
    recordUpgradeSignal(null);
    expect(getUpgradeSignal()).toBe("required");
  });

  it("suggest 可以升级成 required", () => {
    recordUpgradeSignal("suggest");
    recordUpgradeSignal("required");
    expect(getUpgradeSignal()).toBe("required");
  });

  it("认不出来的值当没说", () => {
    // 服务端将来加了新的等级、老客户端不认识时，宁可不提示也不要瞎挡。
    recordUpgradeSignal("mandatory");
    expect(getUpgradeSignal()).toBeNull();
  });

  it("HTTP 错误响应上的头也读", async () => {
    // 「版本太老」正是服务端打回请求的原因之一，只在 2xx 上读会漏掉最该读
    // 到的那一次。
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "client_too_old" }), {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-Client-Upgrade": "required",
            },
          }),
      ),
    );
    await expect(fetchGatewaySubscription()).rejects.toThrow();
    expect(getUpgradeSignal()).toBe("required");
  });
});
