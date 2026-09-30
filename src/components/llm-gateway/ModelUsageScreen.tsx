import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  fetchGatewayModelUsage,
  GatewayApiError,
  refreshGatewayToken,
  type GatewayModelCap,
  type GatewayModelUsage,
  type GatewayModelUsageWindow,
} from "@/lib/api/llm-gateway";

// 模型用量屏：当前 5 小时 / 7 天窗口里，每个模型用掉了多少额度，以及有份额
// 上限的模型族（如 Fable 最多占 50%）还剩多少。
//
// **一律用「占窗口总额度的百分比」，不显示美元。** 额度的美元数对用户没有意义，
// 只会引出「$400 能用多久」这类回答不了的追问 —— 理由同 planCatalog。
//
// 数字全部来自服务端（GET /v1/usage/models），客户端不自己按模型名归类：
// 哪些模型算一族、上限多少，是管理员在后台配的，随时会变。

type WindowKey = "five_hour" | "seven_day";

function gatewayErrorStatus(error: unknown): number {
  return error instanceof GatewayApiError ? error.status : 0;
}

const WINDOW_LABELS: Record<WindowKey, string> = {
  five_hour: "5 小时",
  seven_day: "7 天",
};

// 和账号屏的用量条同一套阈值与配色 —— 两屏并排看时，同一个百分比不能一红一蓝。
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

function WindowSection({
  windowKey,
  window: w,
  caps,
}: {
  windowKey: WindowKey;
  window: GatewayModelUsageWindow;
  caps: GatewayModelCap[];
}) {
  // 失败的请求在服务端也记一行 0 用量（请求确实发生过），这里只列真正耗了额度的。
  const models = w.models.filter((m) => m.charged_micros > 0);
  const capsHere = caps.filter((c) => c[windowKey]);
  // 占这个窗口总额度的比例，不是占已用量的比例：所有模型和总数同一个刻度，
  // 否则一个只用了 1% 的模型会画成满条。
  const shareOfCap = (micros: number) =>
    w.cap_micros > 0 ? clampPct((micros / w.cap_micros) * 100) : 0;
  const totalPct = shareOfCap(w.charged_micros);
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>{WINDOW_LABELS[windowKey]}</span>
        <span className={totalPct >= 90 ? "font-semibold text-red-500" : ""}>
          已用 {totalPct.toFixed(1)}%
        </span>
      </div>

      {models.length === 0 ? (
        <div className="py-1 text-center text-[11px] text-muted-foreground">
          这个窗口还没有用量
        </div>
      ) : (
        <div className="space-y-1.5">
          {models.map((m) => {
            const pct = shareOfCap(m.charged_micros);
            return (
              <div key={m.model}>
                <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                  <span className="min-w-0 truncate font-mono" title={m.model}>
                    {m.model}
                  </span>
                  <span className="shrink-0 text-foreground">
                    {pct.toFixed(1)}%
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {m.requests} 次
                    </span>
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {capsHere.length > 0 && (
        <div className="space-y-2 border-t border-border pt-2.5">
          {capsHere.map((cap) => (
            <ModelCapBar key={cap.id} cap={cap} windowKey={windowKey} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ModelUsageScreen({
  onUnauthorized,
}: {
  // token 在别的设备上被轮换掉之后，换一次 token 也救不回来时调用。
  onUnauthorized: () => void;
}) {
  const [data, setData] = useState<GatewayModelUsage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    // 401 先换 token 再试一次，和账号屏的用量刷新同一套自愈逻辑。
    (async () => {
      try {
        let res: GatewayModelUsage;
        try {
          res = await fetchGatewayModelUsage();
        } catch (error) {
          if (gatewayErrorStatus(error) !== 401) throw error;
          try {
            await refreshGatewayToken();
          } catch {
            if (!cancelled) onUnauthorized();
            return;
          }
          res = await fetchGatewayModelUsage();
        }
        if (!cancelled) {
          setData(res);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "loading") {
    return (
      <div className="flex justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (state === "error" || !data) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        暂时拿不到模型用量，请稍后再试
      </div>
    );
  }
  if (!data.five_hour && !data.seven_day) {
    return (
      <div className="py-6 text-center text-xs text-muted-foreground">
        开通套餐后可查看各模型的用量
      </div>
    );
  }

  const caps = data.model_caps ?? [];
  return (
    <div className="space-y-3">
      {caps.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {caps
            .map((c) => `${c.label} 最多占总额度的 ${formatShare(c.share_bps)}`)
            .join("；")}
          。用完后这类模型会暂停，其它模型不受影响。
        </p>
      )}
      {data.five_hour && (
        <WindowSection
          windowKey="five_hour"
          window={data.five_hour}
          caps={caps}
        />
      )}
      {data.seven_day && (
        <WindowSection
          windowKey="seven_day"
          window={data.seven_day}
          caps={caps}
        />
      )}
    </div>
  );
}
