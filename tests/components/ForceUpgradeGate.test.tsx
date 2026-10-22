import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { ForceUpgradeGate } from "@/components/ForceUpgradeGate";
import * as gateway from "@/lib/api/llm-gateway";
import { providersApi, settingsApi } from "@/lib/api";
import { forwardingFlagKey } from "@/lib/apps";
import { APP_VERSION } from "@/lib/clientUpgrade";
import {
  parseVersion,
  recordUpgradeRefusal,
  resetForceUpgrade,
} from "@/lib/forceUpgrade";
import { act } from "react";

// 低于最低版本：弹出关不掉的升级窗口，所有转发撤掉并还原。
const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  loading: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

function nextMinor(): string {
  const [major, minor] = parseVersion(APP_VERSION)!;
  return `${major}.${minor + 1}.0`;
}

function renderGate() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ForceUpgradeGate />
    </QueryClientProvider>,
  );
}

let isForwarding: MockInstance<typeof providersApi.isForwarding>;
let stopForwarding: MockInstance<typeof providersApi.stopForwarding>;

beforeEach(() => {
  localStorage.clear();
  resetForceUpgrade();
  vi.restoreAllMocks();
  isForwarding = vi
    .spyOn(providersApi, "isForwarding")
    .mockImplementation(async (app) => app === "claude" || app === "codex");
  stopForwarding = vi
    .spyOn(providersApi, "stopForwarding")
    .mockResolvedValue(undefined);
  vi.spyOn(providersApi, "updateTrayMenu").mockResolvedValue(true);
});

afterEach(() => {
  resetForceUpgrade();
});

describe("ForceUpgradeGate", () => {
  it("stays out of the way when the version is new enough", async () => {
    const fetch = vi
      .spyOn(gateway, "fetchGatewayClientVersion")
      .mockResolvedValue({ min_version: APP_VERSION, suggest_version: "" });
    renderGate();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(stopForwarding).not.toHaveBeenCalled();
  });

  it("locks below the minimum and stops every forwarding app", async () => {
    localStorage.setItem(forwardingFlagKey("claude"), "1");
    vi.spyOn(gateway, "fetchGatewayClientVersion").mockResolvedValue({
      min_version: nextMinor(),
      suggest_version: "",
    });
    const user = userEvent.setup();
    renderGate();

    expect(await screen.findByText("forceUpgrade.title")).toBeInTheDocument();
    await waitFor(() => expect(stopForwarding).toHaveBeenCalledTimes(2));
    expect(stopForwarding).toHaveBeenCalledWith("claude");
    expect(stopForwarding).toHaveBeenCalledWith("codex");
    expect(isForwarding).toHaveBeenCalledWith("claude-desktop");
    expect(localStorage.getItem(forwardingFlagKey("claude"))).toBeNull();

    // 关不掉。
    await user.keyboard("{Escape}");
    expect(screen.getByText("forceUpgrade.title")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).not.toBeInTheDocument();
  });

  it("runs the app updater from the button", async () => {
    vi.spyOn(gateway, "fetchGatewayClientVersion").mockResolvedValue({
      min_version: nextMinor(),
      suggest_version: "",
    });
    const info = {
      current: APP_VERSION,
      latest: nextMinor(),
      updateAvailable: true,
      installable: false,
      releaseUrl: "https://example.test/releases",
    };
    vi.spyOn(settingsApi, "checkAppUpdate").mockResolvedValue(info);
    const open = vi.spyOn(settingsApi, "openExternal").mockResolvedValue();
    const user = userEvent.setup();
    renderGate();

    await user.click(
      await screen.findByRole("button", { name: "forceUpgrade.update" }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://example.test/releases"),
    );
  });

  it("locks on a 426 seen elsewhere and unlocks once the server lowers the bar", async () => {
    const fetch = vi
      .spyOn(gateway, "fetchGatewayClientVersion")
      .mockRejectedValue(new Error("offline"));
    renderGate();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => recordUpgradeRefusal(undefined));
    expect(
      await screen.findByText("forceUpgrade.bodyNoVersion"),
    ).toBeInTheDocument();

    // 锁着的时候每次回到前台都查，不受间隔限制。
    fetch.mockResolvedValue({ min_version: "", suggest_version: "" });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
