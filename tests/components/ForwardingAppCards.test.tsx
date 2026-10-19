import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { ForwardingAppCards } from "@/components/forwarding/ForwardingAppCards";
import { providersApi } from "@/lib/api";
import {
  GATEWAY_FORWARDING_BUSY_EVENT,
  GATEWAY_TOGGLE_FORWARDING_EVENT,
  type ForwardableApp,
} from "@/lib/apps";
import { createTestQueryClient } from "../utils/testQueryClient";

// 卡片只读状态、只派发请求：转发流程本身在面板里，见 LlmGatewaySubscriptionDock 的测试。
function renderCards(...args: Parameters<typeof ForwardingAppCards>) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ForwardingAppCards {...args[0]} />
    </QueryClientProvider>,
  );
}

const card = (name: string) =>
  screen.getByText(name).closest('[role="button"]') as HTMLElement;

describe("ForwardingAppCards", () => {
  const toggled: ForwardableApp[] = [];
  const onToggle = (e: Event) =>
    toggled.push((e as CustomEvent<ForwardableApp>).detail);

  beforeEach(() => {
    toggled.length = 0;
    window.addEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, onToggle);
    vi.spyOn(providersApi, "isForwarding").mockImplementation(
      async (app) => app === "codex",
    );
  });

  afterEach(() => {
    window.removeEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, onToggle);
    vi.restoreAllMocks();
  });

  it("每个可转发的 app 一张卡，状态读后端", async () => {
    renderCards({});

    await waitFor(() =>
      expect(card("Codex")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(card("Claude Code")).toHaveAttribute("aria-pressed", "false");
    expect(card("Claude App")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Gemini")).toBeNull();
  });

  it("隐藏的 app 不出卡", () => {
    renderCards({
      visibleApps: {
        claude: true,
        "claude-desktop": true,
        codex: false,
        gemini: true,
      },
    });

    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("点卡片派发该 app 的转发请求", async () => {
    renderCards({});

    await userEvent.click(card("Claude App"));

    expect(toggled).toEqual(["claude-desktop"]);
  });

  it("面板忙的时候卡片不再派发请求", async () => {
    renderCards({});
    act(() => {
      window.dispatchEvent(
        new CustomEvent(GATEWAY_FORWARDING_BUSY_EVENT, { detail: "codex" }),
      );
    });

    await userEvent.click(card("Codex"));
    await userEvent.click(card("Claude Code"));

    expect(toggled).toEqual([]);
    expect(card("Claude Code")).toHaveAttribute("aria-disabled", "true");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(GATEWAY_FORWARDING_BUSY_EVENT, { detail: null }),
      );
    });
    await userEvent.click(card("Claude Code"));
    expect(toggled).toEqual(["claude"]);
  });
});
