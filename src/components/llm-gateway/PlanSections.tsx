import { ArrowLeftRight, PackagePlus } from "lucide-react";
import {
  planRole,
  type GatewaySubscriptionPlan,
  type GatewaySubscriptionStatus,
} from "@/lib/api/llm-gateway";
import { formatMicrosUSD, formatPlanDate, planLabel } from "./planCatalog";

// 账号屏的套餐区。分两块是因为加了 grant 角色之后，平铺显示分不清哪张是
// 「我的档位」、哪张是临时补的加量包 —— 用户看到一堆并列的套餐，不知道点
// 「换档」会换掉哪一个。
//
// 老服务端不返回 role，planRole() 把它们全部归到 subscription，于是所有
// 套餐落在「我的套餐」块里，视觉上退化成接近改动前的平铺。**没有为老服务端
// 单独写一套渲染逻辑** —— 那种分叉迟早会有一边烂掉。

export interface PlanSectionsProps {
  subscription: GatewaySubscriptionStatus;
  /** 进入换档/续费流程。服务端没有报价端点时不渲染这个入口。 */
  onSwitchPlan?: () => void;
  /** 进入加量包购买流程。 */
  onBuyExtra?: () => void;
  /**
   * 能否购买加量包。服务端规定必须有生效的**订阅层**才能买（只有加量包、
   * 订阅已过期时会被拒），所以这里在入口就置灰。
   * 置灰而不是隐藏 —— 用户手上还有加量包在跑却找不到再买一个的地方，
   * 会以为是 bug。
   */
  canBuyExtra: boolean;
}

function quotaLine(plan: GatewaySubscriptionPlan): string {
  return `5h ${formatMicrosUSD(plan.usage_micros_per_5h)} · 周 ${formatMicrosUSD(
    plan.usage_micros_per_week,
  )}`;
}

export function PlanSections({
  subscription,
  onSwitchPlan,
  onBuyExtra,
  canBuyExtra,
}: PlanSectionsProps) {
  const plans = subscription.plans ?? [];
  const subscriptions = plans.filter((p) => planRole(p) === "subscription");
  // 排队中的降档/续费。正常情况下生效的订阅层恰好一张，但老服务端把所有
  // 叠加的套餐都塞在这里，所以是列表而不是单个。
  const current = subscriptions.filter((p) => !p.pending);
  const queued = subscriptions.filter((p) => p.pending);
  // 服务端已按 valid_until 排好序，客户端不重排 —— 那个顺序表达的是
  // 「先扣哪一层」，重排会让用户对不上账。
  const extras = plans.filter((p) => planRole(p) === "extra");

  // 老服务端连 plans 都不返回：退回单行有效期，和加换档之前一样。
  if (plans.length === 0) {
    if (!subscription.active || !subscription.valid_until) return null;
    return (
      <div className="mb-3.5 -mt-1.5 text-center text-[11px] text-muted-foreground">
        有效期至 {formatPlanDate(subscription.valid_until)}
      </div>
    );
  }

  return (
    <div className="mb-3.5 -mt-1 space-y-3">
      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            我的套餐
          </span>
          {onSwitchPlan && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
              onClick={onSwitchPlan}
            >
              <ArrowLeftRight className="h-3 w-3" />
              换档
            </button>
          )}
        </div>
        {current.length === 0 ? (
          <div className="rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            当前没有生效的套餐
          </div>
        ) : (
          <div className="space-y-1">
            {current.map((p) => (
              <div
                key={p.grant_id}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11px]"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {planLabel(p.tier)}
                  <span className="text-muted-foreground">{quotaLine(p)}</span>
                </span>
                <span className="flex-none text-muted-foreground">
                  至 {formatPlanDate(p.valid_until)}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* 排队中的套餐。不写成一行「待生效」标签而是完整一句话：用户需要
            知道换的是哪一档、什么时候换，否则会以为额度已经到账了。 */}
        {queued.map((p) => (
          <div
            key={p.grant_id}
            className="mt-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            到期后自动切换到 {planLabel(p.tier)}（生效于{" "}
            {formatPlanDate(p.valid_from)}）
          </div>
        ))}
        {/* 额度上限显示的是服务端给的总和（订阅层 + 所有加量包），因为那才是
            实际卡用户的值。只显示订阅层的话，买了加量包的人会以为钱白花了。 */}
        {subscription.usage_micros_per_5h != null &&
          subscription.usage_micros_per_week != null && (
            <div className="mt-1 px-0.5 text-[10px] text-muted-foreground">
              额度上限 5h {formatMicrosUSD(subscription.usage_micros_per_5h)} ·
              每周 {formatMicrosUSD(subscription.usage_micros_per_week)}
              {extras.length > 0 && "（含加量包）"}
            </div>
          )}
      </section>

      {/* 没有加量包就整块不渲染 —— 大多数用户不会买，不该给他们一个空标题。 */}
      {extras.length > 0 && (
        <section>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              加量包
            </span>
            {onBuyExtra && (
              <button
                type="button"
                disabled={!canBuyExtra}
                title={
                  canBuyExtra ? undefined : "需要有生效的套餐才能购买加量包"
                }
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
                onClick={onBuyExtra}
              >
                <PackagePlus className="h-3 w-3" />
                再买一个
              </button>
            )}
          </div>
          <div className="space-y-1">
            {extras.map((p) => (
              <div
                key={p.grant_id}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11px]"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {/* 档位名而不是又一句「加量包」：块标题已经说过了，
                      重复一遍反而看不出这几张之间的差别。 */}
                  {planLabel(p.tier)}
                  <span className="text-muted-foreground">{quotaLine(p)}</span>
                  {p.pending && (
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      待生效
                    </span>
                  )}
                </span>
                <span className="flex-none text-muted-foreground">
                  至 {formatPlanDate(p.valid_until)}
                </span>
              </div>
            ))}
          </div>
          {/* 订阅过期后已买的加量包继续供额度到它自己的到期日，只是期间买不了
              新的。这是有意的产品行为，所以这里说明原因而不是把入口藏掉。 */}
          {!canBuyExtra && (
            <div className="mt-1 px-0.5 text-[10px] leading-relaxed text-muted-foreground">
              需要有生效的套餐才能购买加量包；已买的加量包不受影响，会用到各自的到期日
            </div>
          )}
        </section>
      )}
    </div>
  );
}
