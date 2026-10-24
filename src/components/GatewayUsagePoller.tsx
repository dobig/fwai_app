import { useEffect } from "react";
import {
  fetchGatewayUsage,
  loadGatewayTokens,
  loadGatewayUsageCache,
  saveGatewayUsageCache,
} from "@/lib/api/llm-gateway";

// 用量最多这么久刷新一次。
export const USAGE_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
// 多久看一次缓存够不够旧。按缓存时间判断而不是每 20 分钟盲刷：面板自己刚
// 拉过的话这一轮就省掉，下一次从那一刻起算。
export const USAGE_POLL_CHECK_MS = 60 * 1000;
// 失败后至少隔这么久再试：token 已作废或断网时，不该每分钟敲一次网关。
export const USAGE_RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

/**
 * 登录后在后台定时刷新用量，不管网关面板开没开。
 *
 * 用量条因此保持新鲜；更重要的是网关靠 App 发的带登录态请求（都带
 * X-Client-Version）记录每台设备当前的版本，而 App 以前只在打开面板、回到
 * 前台时才发——缩在托盘里转发一整天，网关一次也看不到它。启动时立即查一次，
 * 升级重启后网关马上就知道新版本。
 *
 * 失败一律静默，下一轮再试。尤其不在这里刷新 token：刷新会轮换，旧 token
 * 立刻作废，正在跑的 Claude Code / Codex 会话拿着它就断了。401 留给面板处理。
 *
 * 窗口隐藏时系统可能降频或暂停定时器，所以回到前台时也查一次。
 */
export function GatewayUsagePoller() {
  useEffect(() => {
    let inFlight = false;
    let failedAt = 0;
    const refreshIfStale = async () => {
      const token = loadGatewayTokens()?.access_token;
      if (inFlight || !token) return;
      const now = Date.now();
      const fetchedAt = loadGatewayUsageCache()?.fetchedAt ?? 0;
      if (now - fetchedAt < USAGE_REFRESH_INTERVAL_MS) return;
      if (now - failedAt < USAGE_RETRY_AFTER_FAILURE_MS) return;
      inFlight = true;
      try {
        const usage = await fetchGatewayUsage();
        failedAt = 0;
        // 请求期间登出或换了账号的话，这份用量不是当前账号的，丢掉。
        if (loadGatewayTokens()?.access_token === token) {
          saveGatewayUsageCache(usage);
        }
      } catch (error) {
        failedAt = Date.now();
        console.debug("[GatewayUsagePoller] refresh failed", error);
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      void refreshIfStale();
    };

    void refreshIfStale();
    const timer = setInterval(() => void refreshIfStale(), USAGE_POLL_CHECK_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
