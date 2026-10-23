// 换档结账页。付款前把账算给用户看。
//
// 金额抵扣模式下**升档不延长到期日，而是按新买的时长重算**：Pro 年付还剩
// 300 天的人升到 Business 月付，新到期日就是 30 天后，那 300 天折成了余额。
// 钱一分没少，但用户看到到期日从 300 天后变成 30 天后一定会炸 —— 唯一的
// 解法就是在付款前把抵扣额、新到期日、剩余余额、实付金额四个数字**同时**
// 摆出来。所以这四个数字不折叠、不藏进「详情」。
//
// 这里**不做任何金额计算**，四个数字全部来自服务端 quote；主文案和风险提示
// 也是 quote 里服务端写好的句子。

import { AlertTriangle, Loader2 } from "lucide-react";
import type { GatewayPlanQuote } from "@/lib/api/llm-gateway";
import { fillServerText, formatMicrosUSD, formatPlanDate } from "./planCatalog";

interface PlanCheckoutProps {
  quote: GatewayPlanQuote;
  /** 这一单买给哪一家的显示名。老服务端不分厂商时不传。 */
  vendorName?: string;
  busy?: boolean;
  onConfirm: () => void;
}

export function PlanCheckout({
  quote,
  vendorName,
  busy,
  onConfirm,
}: PlanCheckoutProps) {
  // 主文案和风险提示都是服务端按 action 写好的：升档抵扣多少、续费延到哪天、
  // 排队什么时候切换、同一档为什么排队……这些说法每一条都对应一条规则，规则
  // 改了文案就得改，所以不在客户端拼。日期是占位符，按本地时区填。
  const dates = {
    new_valid_from: formatPlanDate(quote.new_valid_from),
    new_valid_until: formatPlanDate(quote.new_valid_until),
  };
  const headline = fillServerText(quote.headline, dates);
  const notice = fillServerText(quote.notice, dates);
  // 两笔抵扣分两行，因为它们是两回事：套餐折抵是这次换档现算出来的（旧档剩余
  // 价值 + 被吸收的排队档），余额抵扣花的是账户里本来就有的钱。这一行原先只有
  // 一个「余额抵扣」，读的却是 credit_applied_micros —— 于是升档时几百刀的套餐
  // 折抵被贴上「余额」的标签（用户以为账户里有这么多钱），而真正花掉的余额一行
  // 都没有（用户看着余额变少，页面上找不到解释）。服务端从一开始就把两个字段
  // 分开发，就是为了让这里分开显示。
  //
  // 各自为零时整行不渲染：写「-$0」既没有信息又占位置，而「这一单没动余额」本来
  // 就该由「没有这一行」来表达。剩余余额那行则无条件显示 —— 它是状态不是事件。
  const rows: { label: string; value: string; hint?: string }[] = [
    ...(quote.credit_applied_micros > 0
      ? [
          {
            label: "套餐折抵",
            value: `-${formatMicrosUSD(quote.credit_applied_micros)}`,
          },
        ]
      : []),
    ...((quote.balance_applied_micros ?? 0) > 0
      ? [
          {
            label: "余额抵扣",
            value: `-${formatMicrosUSD(quote.balance_applied_micros ?? 0)}`,
          },
        ]
      : []),
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
        {/* 付款前最后一次说清买的是哪一家 —— 换档、续费都只作用于这一家，
            另一家的套餐不受影响。 */}
        {vendorName && ` · ${vendorName}`}
      </div>
      <div className="rounded-xl border-[1.5px] border-border px-3 py-2.5 text-[11px] leading-relaxed">
        {headline && (
          <div className="mb-2 text-xs font-semibold leading-relaxed">
            {headline}
          </div>
        )}
        <div className="space-y-1">
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

      {/* 需要醒目提示的风险（目前是排队单的「不退款，但改主意时全额折抵」）。
          有没有、说什么都由服务端决定；保留警告色 —— 钱是真要付出去的。 */}
      {notice && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>{notice}</span>
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
