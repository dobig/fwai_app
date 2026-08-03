// 换档结账页。付款前把账算给用户看。
//
// 金额抵扣模式下**升档不延长到期日，而是按新买的时长重算**：Pro 年付还剩
// 300 天的人升到 Business 月付，新到期日就是 30 天后，那 300 天折成了余额。
// 钱一分没少，但用户看到到期日从 300 天后变成 30 天后一定会炸 —— 唯一的
// 解法就是在付款前把抵扣额、新到期日、剩余余额、实付金额四个数字**同时**
// 摆出来。所以这四个数字不折叠、不藏进「详情」。
//
// 这里**不做任何金额计算**，四个数字全部来自服务端 quote。

import { AlertTriangle, Loader2 } from "lucide-react";
import type { GatewayPlanQuote } from "@/lib/api/llm-gateway";
import { formatMicrosUSD, formatPlanDate, planLabel } from "./planCatalog";

interface PlanCheckoutProps {
  quote: GatewayPlanQuote;
  /** 当前生效订阅的到期日，用于 queue 文案里的「什么时候切换」。 */
  currentValidUntil?: string;
  busy?: boolean;
  onConfirm: () => void;
}

/** 主文案。排队与否、立即与否，全部由服务端的 action 决定。 */
function actionHeadline(
  quote: GatewayPlanQuote,
  currentValidUntil?: string,
): string {
  switch (quote.action) {
    case "upgrade_now":
      // 只说金额，不说「剩余 X 天」—— 天数得从抵扣额反推，和服务端的取整
      // 规则对不上时反而制造客诉。
      return `立即升级到 ${planLabel(quote.target_tier)}，旧套餐剩余时长已折算抵扣 ${formatMicrosUSD(quote.credit_applied_micros)}`;
    case "renew":
      // 不提抵扣 —— 续费没有任何东西被替换掉，旧的时长一天都不作废，
      // 说「抵扣 $0」只会让用户以为亏了。用户要确认的是新的到期日。
      return `续费 ${planLabel(quote.target_tier)}，有效期延长至 ${formatPlanDate(quote.new_valid_until)}`;
    case "queue": {
      // 优先用服务端算好的生效日。currentValidUntil 只是老服务端（不发
      // new_valid_from）的兜底：它取的是**当前生效档**的到期日，而服务端排到的是
      // 订阅层里最远的到期日，用户已经排了一个降档时两者差一整个周期。
      const when = formatPlanDate(quote.new_valid_from ?? currentValidUntil);
      return `当前套餐到期后${when ? `（${when}）` : ""}自动切换到 ${planLabel(quote.target_tier)}`;
    }
    case "activate_now":
      return `立即生效：${planLabel(quote.target_tier)}`;
    case "extra":
      return "加量包立即生效，与当前套餐额度叠加";
  }
}

export function PlanCheckout({
  quote,
  currentValidUntil,
  busy,
  onConfirm,
}: PlanCheckoutProps) {
  const rows: { label: string; value: string; hint?: string }[] = [
    {
      label: "余额抵扣",
      value: `-${formatMicrosUSD(quote.credit_applied_micros)}`,
    },
    {
      label: quote.action === "queue" ? "切换后有效期至" : "新的有效期至",
      value: formatPlanDate(quote.new_valid_until) || "—",
    },
    {
      label: "剩余余额",
      value: formatMicrosUSD(quote.resulting_balance_micros),
      hint: "余额自动用于后续购买",
    },
  ];

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        确认订单
      </div>
      <div className="rounded-xl border-[1.5px] border-border px-3 py-2.5 text-[11px] leading-relaxed">
        <div className="text-xs font-semibold leading-relaxed">
          {actionHeadline(quote, currentValidUntil)}
        </div>
        <div className="mt-2 space-y-1">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-medium">{row.value}</span>
              </div>
              {row.hint && (
                <div className="text-[10px] text-muted-foreground">
                  {row.hint}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-muted-foreground">实付</span>
          <span className="text-sm font-semibold">
            {formatMicrosUSD(quote.amount_due_micros)}
          </span>
        </div>
      </div>

      {/* 降档/续费排队不退款、不可取消（服务端没有取消端点）。这里先说一次，
          点下去还会再弹一次确认 —— 一行小字挡不住误操作。 */}
      {quote.action === "queue" && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>此操作不可撤销、不退款。切换前当前套餐照常可用。</span>
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {/* 零元单不下微信单（微信最低 1 分），按钮不能写「微信支付 $0」——
            用户会等一个永远不会出现的二维码。完整路径见 #12。 */}
        {quote.amount_due_micros === 0
          ? "确认（余额已够，无需付款）"
          : `微信支付 ${formatMicrosUSD(quote.amount_due_micros)}`}
      </button>
    </div>
  );
}
