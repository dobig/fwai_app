import {
  ArrowLeft,
  Building2,
  Check,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type {
  GatewayOrganization,
  GatewayOrgProject,
  GatewayProjectWindow,
} from "@/lib/api/llm-gateway";

// 组织成员的项目区块与切换屏。
//
// **只显示百分比，不显示金额**，理由同 ModelCapBar。不按项目数分支：一个项目
// 和多个项目长得完全一样，入口都是账号屏那一行 —— 少一种界面，就少一种
// 「为什么我这里没有切换按钮」。

// 和账号屏的 UsageBar 同一套阈值与配色 —— 同一个百分比不能一红一蓝。
function isNear(pct: number): boolean {
  return pct >= 90;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function formatPct(pct: number): string {
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

export function currentOrgProject(
  org: GatewayOrganization,
): GatewayOrgProject | null {
  return org.projects.find((p) => p.id === org.current_project_id) ?? null;
}

// 账号屏上的「组织项目」一行：组织名 + 当前项目，点进去是切换屏。
// 没有项目时不可点 —— 进去也是一个空列表。
export function OrgProjectRow({
  org,
  onOpen,
}: {
  org: GatewayOrganization;
  onOpen: () => void;
}) {
  const current = currentOrgProject(org);
  const canOpen = org.projects.length > 0;
  return (
    <div className="mb-3.5 -mt-1">
      <div className="mb-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
        组织项目
      </div>
      <button
        type="button"
        disabled={!canOpen}
        onClick={onOpen}
        className="group flex w-full items-center gap-2.5 rounded-lg bg-muted/40 px-2.5 py-2 text-left transition enabled:hover:bg-muted disabled:cursor-default"
      >
        <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-background text-muted-foreground ring-1 ring-border">
          <Building2 className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10px] text-muted-foreground">
            {org.organization.name}
          </span>
          {current ? (
            <span className="block truncate text-xs font-semibold">
              {current.name}
            </span>
          ) : (
            <span className="block truncate text-xs text-muted-foreground">
              未加入项目
            </span>
          )}
        </span>
        {current && !current.has_allowance && (
          <span className="flex-none rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            无额度
          </span>
        )}
        {canOpen && (
          <ChevronRight className="h-4 w-4 flex-none text-muted-foreground transition group-hover:translate-x-0.5" />
        )}
      </button>
    </div>
  );
}

// 项目卡里的紧凑用量条：两列并排，比账号屏的 UsageBar 细一号。
function ProjectWindowBar({
  label,
  window: w,
  formatReset,
}: {
  label: string;
  window: GatewayProjectWindow;
  formatReset: (iso?: string) => string;
}) {
  const pct = clampPct(w.used_percent);
  const near = isNear(pct);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={near ? "font-semibold text-red-500" : "text-foreground"}
        >
          {formatPct(pct)}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${near ? "bg-red-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {w.resets_at && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {formatReset(w.resets_at)} 重置
        </div>
      )}
    </div>
  );
}

// 切换屏。外层由调用方钉成账号屏的高度，这里是一个 flex 列：返回和说明固定，
// 列表吃掉剩余空间并在内部滚动 —— 项目再多，面板高度也不跳。
export function ProjectPicker({
  org,
  switchingId,
  error,
  onPick,
  onBack,
  formatReset,
}: {
  org: GatewayOrganization;
  switchingId: string | null;
  error: string | null;
  onPick: (project: GatewayOrgProject) => void;
  onBack: () => void;
  formatReset: (iso?: string) => string;
}) {
  const busy = switchingId != null;
  return (
    <>
      <button
        type="button"
        className="mb-3 inline-flex flex-none items-center gap-1.5 self-start text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-60"
        disabled={busy}
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" />
        返回
      </button>
      <p className="mb-3 flex-none text-xs leading-relaxed text-muted-foreground">
        切换后，之后的请求从所选项目的额度里扣，你所有设备上
        <b className="text-foreground">立即生效</b>。
      </p>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
        <div className="flex flex-col gap-2">
          {org.projects.map((p) => {
            const isCurrent = p.id === org.current_project_id;
            const spinning = switchingId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={busy || isCurrent}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => onPick(p)}
                className={`w-full rounded-xl border-[1.5px] px-3 py-2.5 text-left transition ${
                  isCurrent
                    ? "border-primary bg-primary/5"
                    : "border-border enabled:hover:border-primary/60"
                } ${busy && !spinning ? "opacity-50" : ""} ${
                  !p.has_allowance && !isCurrent ? "bg-muted/30" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`truncate text-[13px] font-semibold ${
                        p.has_allowance ? "" : "text-muted-foreground"
                      }`}
                    >
                      {p.name}
                    </span>
                    {!p.has_allowance && (
                      <span className="flex-none rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        无额度
                      </span>
                    )}
                  </span>
                  {spinning ? (
                    <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-primary" />
                  ) : isCurrent ? (
                    <span className="inline-flex flex-none items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                      <Check className="h-2.5 w-2.5" />
                      当前
                    </span>
                  ) : null}
                </div>
                {p.has_allowance ? (
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    {p.five_hour && (
                      <ProjectWindowBar
                        label="5 小时"
                        window={p.five_hour}
                        formatReset={formatReset}
                      />
                    )}
                    {p.week && (
                      <ProjectWindowBar
                        label="7 天"
                        window={p.week}
                        formatReset={formatReset}
                      />
                    )}
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    这个项目没有给你分配额度
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <div className="mt-2 flex-none text-center text-[11px] font-medium text-red-500">
          {error}
        </div>
      )}
    </>
  );
}
