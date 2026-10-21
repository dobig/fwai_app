import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOUNCEMENT_REFRESH_INTERVAL_MS,
  AnnouncementDialog,
} from "@/components/AnnouncementDialog";
import * as gateway from "@/lib/api/llm-gateway";
import type { GatewayAnnouncement } from "@/lib/api/llm-gateway";
import { settingsApi } from "@/lib/api";
import { ANNOUNCEMENTS_SEEN_KEY } from "@/lib/announcements";

// 服务端公告弹窗：每条只弹一次，排队一条条弹；重要公告不能按 Esc 跳过。
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

function announcement(
  id: string,
  extra: Partial<GatewayAnnouncement> = {},
): GatewayAnnouncement {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    level: "info",
    link_url: "",
    link_label: "",
    published_at: "2026-10-20T08:00:00Z",
    ...extra,
  };
}

const seen = () =>
  JSON.parse(localStorage.getItem(ANNOUNCEMENTS_SEEN_KEY) ?? "[]");

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AnnouncementDialog", () => {
  it("shows unseen announcements one at a time and remembers dismissals", async () => {
    localStorage.setItem(ANNOUNCEMENTS_SEEN_KEY, JSON.stringify(["ann_old"]));
    vi.spyOn(gateway, "fetchGatewayAnnouncements").mockResolvedValue([
      announcement("ann_old"),
      announcement("ann_1"),
      announcement("ann_2"),
    ]);
    const user = userEvent.setup();
    render(<AnnouncementDialog />);

    expect(await screen.findByText("title ann_1")).toBeInTheDocument();
    expect(screen.queryByText("title ann_old")).not.toBeInTheDocument();
    expect(screen.getByText("announcement.more")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "announcement.acknowledge" }),
    );
    expect(await screen.findByText("title ann_2")).toBeInTheDocument();
    expect(screen.queryByText("announcement.more")).not.toBeInTheDocument();
    expect(seen()).toEqual(["ann_old", "ann_1"]);

    await user.click(
      screen.getByRole("button", { name: "announcement.acknowledge" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(seen()).toEqual(["ann_old", "ann_1", "ann_2"]);
  });

  it("lets Escape close an info announcement but not an important one", async () => {
    vi.spyOn(gateway, "fetchGatewayAnnouncements").mockResolvedValue([
      announcement("ann_important", { level: "important" }),
      announcement("ann_info"),
    ]);
    const user = userEvent.setup();
    render(<AnnouncementDialog />);

    expect(await screen.findByText("title ann_important")).toBeInTheDocument();
    expect(screen.getByText("announcement.important")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText("title ann_important")).toBeInTheDocument();
    expect(seen()).toEqual([]);

    await user.click(
      screen.getByRole("button", { name: "announcement.acknowledge" }),
    );
    expect(await screen.findByText("title ann_info")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(seen()).toEqual(["ann_important", "ann_info"]);
  });

  it("opens the link in the browser without dismissing", async () => {
    vi.spyOn(gateway, "fetchGatewayAnnouncements").mockResolvedValue([
      announcement("ann_link", {
        link_url: "https://fwai.space/news",
        link_label: "看看",
      }),
      announcement("ann_default_label", { link_url: "https://fwai.space" }),
    ]);
    const open = vi.spyOn(settingsApi, "openExternal").mockResolvedValue();
    const user = userEvent.setup();
    render(<AnnouncementDialog />);

    await user.click(await screen.findByRole("button", { name: "看看" }));
    expect(open).toHaveBeenCalledWith("https://fwai.space/news");
    expect(screen.getByText("title ann_link")).toBeInTheDocument();
    expect(seen()).toEqual([]);

    await user.click(
      screen.getByRole("button", { name: "announcement.acknowledge" }),
    );
    expect(
      await screen.findByRole("button", { name: "announcement.openLink" }),
    ).toBeInTheDocument();
  });

  it("stays closed when the fetch fails or nothing is new", async () => {
    const fetch = vi
      .spyOn(gateway, "fetchGatewayAnnouncements")
      .mockRejectedValue(new Error("offline"));
    render(<AnnouncementDialog />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("refetches on focus only after the refresh interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi
      .spyOn(gateway, "fetchGatewayAnnouncements")
      .mockResolvedValue([]);
    render(<AnnouncementDialog />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValue([announcement("ann_late")]);
    vi.setSystemTime(Date.now() + ANNOUNCEMENT_REFRESH_INTERVAL_MS + 1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("title ann_late")).toBeInTheDocument();
  });
});
