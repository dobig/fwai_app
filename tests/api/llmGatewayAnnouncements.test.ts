import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGatewayAnnouncements } from "@/lib/api/llm-gateway";
import {
  ANNOUNCEMENTS_SEEN_KEY,
  markAnnouncementSeen,
  unseenAnnouncements,
} from "@/lib/announcements";

// 公告接口是公开的：没登录的用户也要收到，登录了也不带 token。
// 服务端多给、少给或给错字段都不能让整批公告失效。

const TOKEN_KEY = "llm-gateway-oauth";
const BASE_URL_KEY = "llm-gateway-base-url";

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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BASE_URL_KEY, "https://gw.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGatewayAnnouncements", () => {
  it("calls the public endpoint without a token even when logged in", async () => {
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ access_token: "access-token" }),
    );
    const fetchMock = mockFetch(200, { announcements: [] });

    await expect(fetchGatewayAnnouncements()).resolves.toEqual([]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.test/v1/announcements");
    expect(init.method).toBe("GET");
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("keeps well-formed items and normalizes the optional fields", async () => {
    mockFetch(200, {
      announcements: [
        {
          id: "ann_1",
          title: "维护通知",
          body: "今晚维护",
          level: "important",
          link_url: "https://fwai.space",
          link_label: "详情",
          published_at: "2026-10-20T08:00:00Z",
        },
        { id: "ann_2", title: "t", body: "b", level: "weird" },
        { id: "", title: "t", body: "b" },
        { id: "ann_3", title: 1, body: "b" },
        null,
        "junk",
      ],
    });

    await expect(fetchGatewayAnnouncements()).resolves.toEqual([
      {
        id: "ann_1",
        title: "维护通知",
        body: "今晚维护",
        level: "important",
        link_url: "https://fwai.space",
        link_label: "详情",
        published_at: "2026-10-20T08:00:00Z",
      },
      {
        id: "ann_2",
        title: "t",
        body: "b",
        level: "info",
        link_url: "",
        link_label: "",
        published_at: "",
      },
    ]);
  });

  it("treats a missing list as empty and throws on HTTP errors", async () => {
    mockFetch(200, {});
    await expect(fetchGatewayAnnouncements()).resolves.toEqual([]);

    mockFetch(503, { error: "unavailable" });
    await expect(fetchGatewayAnnouncements()).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
  });
});

describe("announcement seen state", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("filters out seen ids and keeps server order", () => {
    markAnnouncementSeen("b");
    expect(unseenAnnouncements(items)).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("treats a corrupt value as nothing seen and heals it", () => {
    localStorage.setItem(ANNOUNCEMENTS_SEEN_KEY, '{"not":"a list"}');
    expect(unseenAnnouncements(items)).toEqual(items);
    expect(localStorage.getItem(ANNOUNCEMENTS_SEEN_KEY)).toBeNull();

    localStorage.setItem(ANNOUNCEMENTS_SEEN_KEY, "not json");
    expect(unseenAnnouncements(items)).toEqual(items);
  });

  it("caps the stored list, dropping the oldest ids", () => {
    for (let i = 0; i < 205; i++) markAnnouncementSeen(`ann_${i}`);
    markAnnouncementSeen("ann_10"); // 已经在列表里：挪到最新，不重复存、不挤掉别的
    const stored: string[] = JSON.parse(
      localStorage.getItem(ANNOUNCEMENTS_SEEN_KEY)!,
    );
    expect(stored).toHaveLength(200);
    expect(stored[0]).toBe("ann_5");
    expect(stored.at(-1)).toBe("ann_10");
    expect(new Set(stored).size).toBe(200);
  });
});
