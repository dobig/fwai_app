import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Terminal } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { Switch } from "@/components/ui/switch";
import { useForwardingQuery } from "@/lib/query";
import {
  APP_DISPLAY_NAME,
  APP_ICON_NAME,
  FORWARDABLE_APPS,
  GATEWAY_FORWARDING_BUSY_EVENT,
  requestToggleForwarding,
  type ForwardableApp,
} from "@/lib/apps";
import { cn } from "@/lib/utils";
import type { VisibleApps } from "@/types";

// 简洁模式的主界面：一个可转发的 app 一张卡，点整张卡开/关它的转发。
//
// 卡片自己不跑转发流程，只派发请求给转发面板（LlmGatewaySubscriptionDock）：
// 登录校验、套餐对账、购买 / 换项目这些分支都是面板的本地状态，需要用户操作
// 时面板自己弹出来。卡片只读后端的转发状态，以及面板广播的「正在忙哪个」。

interface ForwardingAppCardsProps {
  visibleApps?: VisibleApps;
}

export function ForwardingAppCards({ visibleApps }: ForwardingAppCardsProps) {
  const [busyApp, setBusyApp] = useState<ForwardableApp | null>(null);

  useEffect(() => {
    const onBusy = (e: Event) =>
      setBusyApp((e as CustomEvent<ForwardableApp | null>).detail);
    window.addEventListener(GATEWAY_FORWARDING_BUSY_EVENT, onBusy);
    return () =>
      window.removeEventListener(GATEWAY_FORWARDING_BUSY_EVENT, onBusy);
  }, []);

  const apps = FORWARDABLE_APPS.filter(
    (app) => !visibleApps || visibleApps[app] !== false,
  );

  // 一组紧凑的行，而不是一张张大卡：主界面就这几个开关，没必要铺满窗口。
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {apps.map((app) => (
        <ForwardingAppCard
          key={app}
          app={app}
          busy={busyApp === app}
          disabled={busyApp !== null && busyApp !== app}
        />
      ))}
    </div>
  );
}

function ForwardingAppCard({
  app,
  busy,
  disabled,
}: {
  app: ForwardableApp;
  busy: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { data: forwarding = false } = useForwardingQuery(app);
  const toggle = () => {
    if (busy || disabled) return;
    requestToggleForwarding(app);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={forwarding}
      aria-disabled={busy || disabled}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      className={cn(
        "flex cursor-pointer select-none items-center gap-3 px-3 py-2.5 transition-colors",
        "hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
        forwarding && "bg-emerald-500/[0.06] hover:bg-emerald-500/10",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
        <ProviderIcon
          icon={APP_ICON_NAME[app]}
          name={APP_DISPLAY_NAME[app]}
          size={18}
        />
        {/* 和顶部切换器一致：Claude Code 带终端角标，好和 Claude App 区分。 */}
        {app === "claude" && (
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-[11px] w-[11px] items-center justify-center rounded-[3px] border border-border bg-background text-foreground"
            aria-hidden="true"
          >
            <Terminal className="h-[7px] w-[7px]" strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 truncate text-sm font-medium">
        {APP_DISPLAY_NAME[app]}
      </div>
      <span
        className={cn(
          "shrink-0 text-xs",
          forwarding
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground",
        )}
      >
        {forwarding
          ? t("forwarding.cards.on", { defaultValue: "转发中" })
          : t("forwarding.cards.off", { defaultValue: "未转发" })}
      </span>
      <div className="flex w-9 shrink-0 items-center justify-end">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          // 纯展示：点击由整张卡处理，开关本身不接事件，免得点一下触发两次。
          <Switch
            checked={forwarding}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none h-5 w-9 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4"
          />
        )}
      </div>
    </div>
  );
}
