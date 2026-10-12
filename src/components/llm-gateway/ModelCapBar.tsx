import type { GatewayModelCap } from "@/lib/api/llm-gateway";

// 账号屏用量区里的模型族份额条（如 Fable 最多占总额度的 50%）。
//
// **只显示百分比，不显示美元。** 额度的美元数对用户没有意义，只会引出
// 「$400 能用多久」这类回答不了的追问 —— 理由同 planCatalog。哪些模型算一族、
// 上限多少，全部来自服务端（GET /api/oauth/usage 的 model_caps），客户端不自己
// 按模型名归类。

type WindowKey = "five_hour" | "seven_day";

// 和上方总用量条（UsageBar）同一套阈值与配色 —— 同一个百分比不能一红一蓝。
function barTone(pct: number): string {
  return pct >= 90 ? "bg-red-500" : "bg-primary";
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// 份额上限的百分比文案。基点整除 100 时不带小数：「50%」而不是「50.00%」。
export function formatShare(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

// 一个模型族在一个窗口里的份额条。上限以「占总额度的 x%」表述：用户关心的是
// 「Fable 还能用多少」，而不是一个脱离总额度的绝对金额。
export function ModelCapBar({
  cap,
  windowKey,
}: {
  cap: GatewayModelCap;
  windowKey: WindowKey;
}) {
  const w = cap[windowKey];
  if (!w) return null;
  const pct = clampPct(w.utilization);
  const full = pct >= 100;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">
          {cap.label}
          <span className="ml-1.5 text-[10px]">
            · 最多占 {formatShare(cap.share_bps)}
          </span>
        </span>
        <span
          className={
            pct >= 90 ? "font-semibold text-red-500" : "text-foreground"
          }
        >
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${barTone(pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {full && (
        // 到顶了就说清楚：换别的模型还能继续用。不说的话用户看到 429 会以为
        // 整个额度都没了。
        <div className="mt-0.5 text-[10px] text-red-500">
          {cap.label} 份额已用完，其它模型仍可使用
        </div>
      )}
    </div>
  );
}
