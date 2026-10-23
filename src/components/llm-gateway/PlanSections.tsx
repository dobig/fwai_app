import { ArrowLeftRight, PackagePlus } from "lucide-react";
import {
  planRole,
  type GatewaySubscriptionPlan,
  type GatewaySubscriptionStatus,
} from "@/lib/api/llm-gateway";
import { fillServerText, formatPlanDate, vendorLabel } from "./planCatalog";

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
}

// 一张套餐叫什么、怎么描述，都是服务端写好的（label / description）。描述
// **永远不显示 5h/周的具体金额** —— 那两个数字对用户没有意义，只会引出
// 「$400 能用多久」这类回答不了的追问 —— 而是「N× Starter 用量」这样的相对
// 说法，且按这张 grant 自己的额度算，不按今天的目录：business 从 20× 改成
// 10× 之后，改之前买的那张到期前仍是 20×。这条规则曾经在客户端实现过一遍，
// 每改一次倍数就要发一版 app，所以搬去了服务端。
//
// 老服务端不发 label 时退回 tier 原值，不发 description 时不写描述。
function planName(plan: GatewaySubscriptionPlan): string {
  return plan.label || plan.tier;
}

// 一份额度是哪一家的。只在有套餐绑了厂商时才标：老服务端、或者手上全是绑定
// 之前买的套餐，标出一排「通用」只是噪音。一旦有绑定的，没绑定的那几份就得
// 标「通用」—— 不然用户会以为它也只给某一家用。
function VendorTag({
  plan,
  show,
}: {
  plan: GatewaySubscriptionPlan;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
      {plan.vendor_label || (plan.vendor ? vendorLabel(plan.vendor) : "通用")}
    </span>
  );
}

export function PlanSections({
  subscription,
  onSwitchPlan,
  onBuyExtra,
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
  const showVendor = plans.some((p) => p.vendor);

  // 老服务端连 plans 都不返回：没有可列的套餐，有效期由账号卡在套餐名下面
  // 显示（见 LlmGatewaySubscriptionDock）。
  if (plans.length === 0) return null;

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
                  <VendorTag plan={p} show={showVendor} />
                  {planName(p)}
                  {p.description && (
                    <span className="text-muted-foreground">
                      {p.description}
                    </span>
                  )}
                </span>
                <span className="flex-none text-muted-foreground">
                  至 {formatPlanDate(p.valid_until)}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* 排队中的套餐。不写成一行「待生效」标签而是完整一句话：用户需要
            知道换的是哪一档、什么时候换，否则会以为额度已经到账了。那句话
            （含「哪一家」「新的一期是几倍」）由服务端写，日期按本地时区填。 */}
        {queued.map((p) => (
          <div
            key={p.grant_id}
            className="mt-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            {p.pending_text
              ? fillServerText(p.pending_text, {
                  valid_from: formatPlanDate(p.valid_from),
                })
              : `${planName(p)} 待生效（${formatPlanDate(p.valid_from)}）`}
          </div>
        ))}
        {/* 总用量（订阅层 + 所有额外额度）是实际卡用户的值，只显示订阅层的话
            买了加量包的人会以为钱白花了。整句由服务端写，用倍数不用金额 ——
            理由同上面的描述。 */}
        {subscription.usage_text && (
          <div className="mt-1 px-0.5 text-[10px] text-muted-foreground">
            {subscription.usage_text}
          </div>
        )}
      </section>

      {/* 没有额外额度就整块不渲染 —— 大多数用户不会有，不该给他们一个空标题。
          标题不叫「加量包」：这一块同时装着自助买的加量包和 admin 发放/兑换码
          得来的专属额度，后者不是买来的，叫加量包会让用户以为自己付过钱。 */}
      {extras.length > 0 && (
        <section>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              额外额度
            </span>
            {onBuyExtra && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
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
                  <VendorTag plan={p} show={showVendor} />
                  {/* 档位名而不是又一句「加量包」：块标题已经说过了，
                      重复一遍反而看不出这几张之间的差别。 */}
                  {planName(p)}
                  {p.description && (
                    <span className="text-muted-foreground">
                      {p.description}
                    </span>
                  )}
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
        </section>
      )}
    </div>
  );
}
