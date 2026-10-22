import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { providersApi, settingsApi } from "@/lib/api";
import { fetchGatewayClientVersion } from "@/lib/api/llm-gateway";
import { FORWARDABLE_APPS, forwardingFlagKey } from "@/lib/apps";
import { applyAppUpdate } from "@/lib/appUpdate";
import { APP_VERSION } from "@/lib/clientUpgrade";
import { applyMinVersion, useForceUpgrade } from "@/lib/forceUpgrade";

// 回到前台时最多这么久查一次门槛。被锁住时每次回到前台都查：管理员可能刚
// 把门槛调低，用户不该非得重启才能解锁。
export const CLIENT_VERSION_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 强制升级：低于管理员设定的最低版本时，弹出关不掉的升级窗口，并把所有转发
 * 关掉、还原原有配置——这个版本的网关请求已经会被拒绝，留着转发只会让
 * Claude Code / Codex 一直报错，还看不出原因。
 *
 * 锁定来源有两个：这里定期查的 /v1/client-version，以及任何一个网关请求收到
 * 的 426（gatewayRequest 里记录）。
 */
export function ForceUpgradeGate() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const lock = useForceUpgrade();
  const [updating, setUpdating] = useState(false);
  const lastFetchRef = useRef(0);
  const lockedRef = useRef(false);
  lockedRef.current = lock !== null;

  const refresh = useCallback(async () => {
    lastFetchRef.current = Date.now();
    try {
      const policy = await fetchGatewayClientVersion();
      applyMinVersion(policy.min_version);
    } catch (error) {
      // 查不到就维持现状：没锁的不因为断网被锁，锁了的也不因为断网解锁。
      console.debug("[ForceUpgradeGate] fetch failed", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (
        !lockedRef.current &&
        Date.now() - lastFetchRef.current < CLIENT_VERSION_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // 一被锁住就把转发全部撤掉。之后的开关请求由 requestToggleForwarding 吞掉。
  const locked = lock !== null;
  useEffect(() => {
    if (!locked) return;
    let cancelled = false;
    void (async () => {
      for (const app of FORWARDABLE_APPS) {
        if (cancelled) return;
        try {
          if (await providersApi.isForwarding(app)) {
            await providersApi.stopForwarding(app);
          }
          localStorage.removeItem(forwardingFlagKey(app));
        } catch (error) {
          console.error(`[ForceUpgradeGate] ${app} 转发还原失败`, error);
        }
        void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
        void queryClient.invalidateQueries({ queryKey: ["providers", app] });
      }
      void providersApi.updateTrayMenu().catch(() => {
        // 非 Tauri 环境没有托盘。
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [locked, queryClient]);

  const update = async () => {
    if (updating) return;
    setUpdating(true);
    try {
      const info = await settingsApi.checkAppUpdate();
      await applyAppUpdate(info, t);
    } catch (error) {
      console.error("[ForceUpgradeGate] update failed", error);
      toast.error(t("forceUpgrade.updateFailed"));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Dialog open={locked}>
      {lock && (
        // 关不掉：没有关闭按钮，Esc 和点遮罩都不响应（点遮罩本来就被
        // DialogContent 挡了）。宽度留出边距，适配简洁模式的窄窗口。
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-md"
          zIndex="top"
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 flex-shrink-0 text-red-500" />
              {t("forceUpgrade.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6 py-5">
            <DialogDescription className="leading-relaxed text-foreground">
              {lock.minVersion
                ? t("forceUpgrade.body", {
                    current: APP_VERSION,
                    min: lock.minVersion,
                  })
                : t("forceUpgrade.bodyNoVersion", { current: APP_VERSION })}
            </DialogDescription>
            <DialogDescription className="leading-relaxed">
              {t("forceUpgrade.forwardingStopped")}
            </DialogDescription>
          </div>
          <DialogFooter className="flex-row justify-end">
            <Button onClick={() => void update()} disabled={updating}>
              <Download className="h-4 w-4" />
              {updating ? t("settings.updating") : t("forceUpgrade.update")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
