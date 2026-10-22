import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ExternalLink, Megaphone, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { settingsApi } from "@/lib/api";
import {
  fetchGatewayAnnouncements,
  type GatewayAnnouncement,
} from "@/lib/api/llm-gateway";
import { markAnnouncementSeen, unseenAnnouncements } from "@/lib/announcements";
import { extractErrorMessage } from "@/utils/errorUtils";

// 窗口重新获得焦点时最多这么久拉一次。公告不需要秒级送达，没必要用定时器：
// 窗口藏在托盘里的时候弹了也没人看见，用户切回来的那一刻再查正好。
export const ANNOUNCEMENT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 服务端公告弹窗：启动时拉一次，之后窗口回到前台时按间隔再拉。没读过的公告
 * 排队，一次弹一条，关掉一条再弹下一条。
 *
 * 普通公告可以按 Esc 关；重要公告只能点「我知道了」，确保用户真的看到了。
 */
export function AnnouncementDialog() {
  const { t, i18n } = useTranslation();
  const [queue, setQueue] = useState<GatewayAnnouncement[]>([]);
  const lastFetchRef = useRef(0);

  const refresh = useCallback(async () => {
    lastFetchRef.current = Date.now();
    try {
      const fresh = unseenAnnouncements(await fetchGatewayAnnouncements());
      if (fresh.length === 0) return;
      setQueue((prev) => {
        const queued = new Set(prev.map((item) => item.id));
        const added = fresh.filter((item) => !queued.has(item.id));
        return added.length > 0 ? [...prev, ...added] : prev;
      });
    } catch (error) {
      // 拉不到就下次再说：网络不通、本地开发没起网关都会走到这里，不值得打扰用户。
      console.debug("[AnnouncementDialog] fetch failed", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (
        Date.now() - lastFetchRef.current <
        ANNOUNCEMENT_REFRESH_INTERVAL_MS
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

  const current = queue[0];
  const important = current?.level === "important";

  const dismiss = () => {
    if (!current) return;
    markAnnouncementSeen(current.id);
    setQueue((prev) => prev.filter((item) => item.id !== current.id));
  };

  const openLink = async () => {
    if (!current?.link_url) return;
    try {
      await settingsApi.openExternal(current.link_url);
    } catch (error) {
      toast.error(
        extractErrorMessage(error) || t("notifications.openLinkFailed"),
      );
    }
  };

  const publishedAt = current
    ? formatDate(current.published_at, i18n.language)
    : "";

  return (
    <Dialog
      open={Boolean(current)}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {current && (
        // 简洁模式下窗口只有 w-96 加两侧留白那么宽、内容那么高：宽度留出边距，
        // 正文过长时在弹窗里滚动，而不是撑破窗口。
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-md"
          zIndex="top"
          onEscapeKeyDown={(event) => {
            if (important) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-start gap-2 leading-snug">
              {important ? (
                <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
              ) : (
                <Megaphone className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500" />
              )}
              <span className="min-w-0 break-words">{current.title}</span>
            </DialogTitle>
            {(important || publishedAt) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {important && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                    {t("announcement.important")}
                  </span>
                )}
                {publishedAt && <span>{publishedAt}</span>}
              </div>
            )}
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <DialogDescription className="whitespace-pre-line break-words leading-relaxed text-foreground">
              {current.body}
            </DialogDescription>
          </div>
          {/* 简洁模式的窗口窄于 sm 断点，DialogFooter 默认会竖着堆，这里始终横排。 */}
          <DialogFooter className="flex-row flex-wrap items-center sm:justify-between">
            {queue.length > 1 && (
              <span className="text-xs text-muted-foreground">
                {t("announcement.more", { count: queue.length - 1 })}
              </span>
            )}
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {current.link_url && (
                <Button variant="outline" onClick={() => void openLink()}>
                  <ExternalLink className="h-4 w-4" />
                  {current.link_label || t("announcement.openLink")}
                </Button>
              )}
              <Button onClick={dismiss}>{t("announcement.acknowledge")}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function formatDate(value: string, language: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleDateString(language, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return date.toLocaleDateString();
  }
}
