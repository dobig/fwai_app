import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/// 窗口是否最大化，给自绘的窗口按钮用。`enabled` 为 false（没有自绘按钮）时
/// 什么都不查，一直是 false。
///
/// 别在没有用途的地方开：isMaximized 在 macOS 上不是只读的。窗口不可拉伸时
/// （简洁模式），tao 要临时改 styleMask 才能问 isZoomed，这会去掉 Overlay
/// 标题栏的 fullSizeContentView，内容区尺寸一变又触发 onResized —— 自己把
/// 自己点着，每秒几百次，每次还漏一个 NSTrackingArea，跑几个小时就是几个 G
/// 内存、整个界面卡死。
export function useWindowMaximized(enabled: boolean) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlistenResize: (() => void) | undefined;

    const setup = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const sync = async () => {
          const next = await currentWindow.isMaximized();
          if (active) setMaximized(next);
        };

        await sync();
        const unlisten = await currentWindow.onResized(() => {
          void sync();
        });
        if (active) unlistenResize = unlisten;
        else unlisten();
      } catch (error) {
        console.error("[App] Failed to sync window maximized state", error);
      }
    };

    void setup();
    return () => {
      active = false;
      unlistenResize?.();
    };
  }, [enabled]);

  return [maximized, setMaximized] as const;
}
