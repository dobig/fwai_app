import { useForwardingAppsQuery } from "@/lib/query";
import { cn } from "@/lib/utils";

// 应用字标「fwai」。
//
// fw 粗、ai 细：forward 是动作，ai 是被转发的东西，靠字重对比把名字拆成这两半，
// 不加任何装饰。右上角一颗状态灯：有任何 app 在走网关时亮绿，否则是灰的，
// 标题栏本身就成了「现在有没有在转发」的指示。
export function Wordmark({
  className,
  live = true,
}: {
  className?: string;
  /// false 时不显示状态灯（比如关于页里只是展示名字）。
  live?: boolean;
}) {
  const forwardingApps = useForwardingAppsQuery();
  const on = forwardingApps.length > 0;

  return (
    <span
      className={cn(
        "inline-flex select-none items-start gap-[0.12em] text-[22px] leading-none tracking-[-0.02em] text-foreground",
        className,
      )}
      aria-label="fwai"
      title={live ? (on ? "转发中" : "未转发") : undefined}
    >
      <span aria-hidden="true">
        <span className="font-bold">fw</span>
        <span className="font-extralight text-foreground/70">ai</span>
      </span>
      {live && (
        <span
          aria-hidden="true"
          className={cn(
            "mt-[0.08em] h-[0.18em] w-[0.18em] flex-none rounded-full transition-colors duration-500",
            on
              ? "bg-emerald-500 shadow-[0_0_0.3em_theme(colors.emerald.400)]"
              : "bg-muted-foreground/40",
          )}
        />
      )}
    </span>
  );
}
