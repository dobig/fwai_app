import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowMaximized } from "@/hooks/useWindowMaximized";

const isMaximized = vi.fn();
const onResized = vi.fn();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isMaximized, onResized }),
}));

describe("useWindowMaximized", () => {
  beforeEach(() => {
    isMaximized.mockReset().mockResolvedValue(false);
    onResized.mockReset().mockResolvedValue(unlisten);
    unlisten.mockReset();
  });

  // 回归：macOS 上 isMaximized 会改 styleMask 并触发 resize，没有自绘窗口按钮
  // 时订阅 onResized 再去问 isMaximized，会自激成每秒几百次的循环。
  it("never touches the window when disabled", async () => {
    const { result } = renderHook(() => useWindowMaximized(false));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isMaximized).not.toHaveBeenCalled();
    expect(onResized).not.toHaveBeenCalled();
    expect(result.current[0]).toBe(false);
  });

  it("tracks the maximized state on resize when enabled", async () => {
    isMaximized.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result, unmount } = renderHook(() => useWindowMaximized(true));

    await waitFor(() => expect(onResized).toHaveBeenCalledTimes(1));
    const handler = onResized.mock.calls[0][0] as () => void;
    handler();
    await waitFor(() => expect(result.current[0]).toBe(true));

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it("unsubscribes when switched off", async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useWindowMaximized(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(onResized).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    expect(unlisten).toHaveBeenCalled();
  });
});
