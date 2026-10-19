import { useEffect } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

// 高级模式的最小尺寸，和 tauri.conf.json 里 main 窗口的 minWidth/minHeight 一致：
// 供应商列表在更窄的窗口里排不开。
const FULL_MIN = new LogicalSize(900, 600);
// 高级模式下窗口的最后尺寸，切回高级模式时还原。没有记录时用 tauri.conf.json 的默认值。
const FULL_SIZE_KEY = "window-full-size";
const FULL_DEFAULT = { width: 1000, height: 650 };

/// 简洁模式下窗口贴合内容。
///
/// 不写死尺寸：量 `content` 的实际大小（加上它四周的留白）作为窗口大小，内容
/// 变了（登录屏 → 账号屏 → 购买屏）窗口跟着变；超过屏幕高度时封顶，剩下的在页面
/// 里滚动。这个模式下窗口不让手动拉伸——尺寸本来就由内容决定。
///
/// 切回高级模式时恢复拉伸、最小尺寸，以及用户上次在高级模式里用的窗口大小。
/// `content` 为 null（比如在设置页）时保持当前尺寸不动。
export function useCompactWindow(
  compact: boolean,
  content: HTMLElement | null,
) {
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      // 非 Tauri 环境（浏览器预览、测试）没有窗口 API。
      return;
    }
    const run = (step: Promise<unknown>) =>
      step.catch((error) =>
        console.debug("[useCompactWindow] window call failed", error),
      );

    if (!compact) {
      const saved = readFullSize();
      run(
        (async () => {
          await win.setResizable(true);
          await win.setMinSize(FULL_MIN);
          await win.setSize(new LogicalSize(saved.width, saved.height));
        })(),
      );
      // 记下高级模式里的尺寸，供下次切回时还原。
      const onResize = () =>
        localStorage.setItem(
          FULL_SIZE_KEY,
          JSON.stringify({
            width: window.innerWidth,
            height: window.innerHeight,
          }),
        );
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    const el = content;
    if (!el) return;
    let last = "";
    const fit = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scroller = el.closest<HTMLElement>(".overflow-y-auto");
      // 内容左右的留白对称；底部用同样的留白，看起来和两侧一致。
      const gutter = Math.max(rect.left, 0);
      const width = Math.ceil(rect.width + gutter * 2);
      const top = rect.top + (scroller?.scrollTop ?? 0);
      const height = Math.ceil(
        Math.min(top + rect.height + gutter, window.screen.availHeight),
      );
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      run(win.setSize(new LogicalSize(width, height)));
    };
    run(
      (async () => {
        await win.setMinSize(null);
        await win.setResizable(false);
        fit();
      })(),
    );
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, content]);
}

function readFullSize(): { width: number; height: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(FULL_SIZE_KEY) ?? "");
    if (saved?.width >= FULL_MIN.width && saved?.height >= FULL_MIN.height) {
      return saved;
    }
  } catch {
    // 没有记录或解析失败，用默认值。
  }
  return FULL_DEFAULT;
}
