import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearGatewayOrgCache,
  fetchGatewayOrganization,
  GatewayApiError,
  loadGatewayOrgCache,
  saveGatewayOrgCache,
  switchGatewayProject,
  type GatewayOrganization,
} from "@/lib/api/llm-gateway";

// 组织项目的 API 层。最要紧的是区分「不是组织成员」和「没问到」：
// 前者（404）返回 null，界面和今天一模一样；后者必须抛出来，调用方保留缓存，
// 不能把一个组织成员误判成个人用户、给他看「购买套餐」。

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

const ORG: GatewayOrganization = {
  organization: { name: "Acme AI 研发中心" },
  current_project_id: "prj_core",
  projects: [
    {
      id: "prj_core",
      name: "核心模型",
      has_allowance: true,
      five_hour: { used_percent: 41, resets_at: "2026-10-16T10:00:00Z" },
      week: { used_percent: 8, resets_at: "2026-10-20T13:15:00Z" },
    },
  ],
};

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

describe("fetchGatewayOrganization", () => {
  it("组织成员：原样返回组织与项目，带登录 token", async () => {
    mockFetchOnce(200, ORG);
    await expect(fetchGatewayOrganization()).resolves.toEqual(ORG);
    expect(captured[0].url).toBe("https://gw.test/v1/me/organization");
    expect(captured[0].init.method).toBe("GET");
    expect(
      (captured[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer access-token");
  });

  it("404 not_org_member 返回 null", async () => {
    mockFetchOnce(404, { error: "not_org_member" });
    await expect(fetchGatewayOrganization()).resolves.toBeNull();
  });

  it("老网关没有这个接口（裸 404）也返回 null", async () => {
    mockFetchOnce(404, { error: "not_found" });
    await expect(fetchGatewayOrganization()).resolves.toBeNull();
  });

  it("其它错误抛出，不当成非组织成员", async () => {
    mockFetchOnce(500, { error: "internal" });
    await expect(fetchGatewayOrganization()).rejects.toBeInstanceOf(
      GatewayApiError,
    );
  });
});

describe("switchGatewayProject", () => {
  it("PUT project_id", async () => {
    mockFetchOnce(200, { current_project_id: "prj_app" });
    await expect(switchGatewayProject("prj_app")).resolves.toEqual({
      current_project_id: "prj_app",
    });
    expect(captured[0].url).toBe("https://gw.test/v1/me/organization/project");
    expect(captured[0].init.method).toBe("PUT");
    expect(JSON.parse(String(captured[0].init.body))).toEqual({
      project_id: "prj_app",
    });
  });

  it("403 project_forbidden 带错误码抛出", async () => {
    mockFetchOnce(403, { error: "project_forbidden" });
    const error = await switchGatewayProject("prj_gone").catch((e) => e);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("project_forbidden");
  });
});

describe("组织缓存", () => {
  it("存取与清除；非组织成员也缓存成 null", () => {
    expect(loadGatewayOrgCache()).toBeNull();
    saveGatewayOrgCache(ORG);
    expect(loadGatewayOrgCache()?.org).toEqual(ORG);
    saveGatewayOrgCache(null);
    const cached = loadGatewayOrgCache();
    expect(cached).not.toBeNull();
    expect(cached?.org).toBeNull();
    clearGatewayOrgCache();
    expect(loadGatewayOrgCache()).toBeNull();
  });
});
