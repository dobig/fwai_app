import type {
  GatewayPlanKind,
  GatewaySubscriptionPlan,
} from "@/lib/api/llm-gateway";
import { vendorLabel } from "./planCatalog";

// 用量卡里按份拆开的周额度（issue #79 / llm_gateway#496）。
//
// 每份额度（订阅层、每一次买的加量包、每一份赠送）从自己生效的那一刻起按
// 7 天一轮刷新，所以「7 天」不能只画一条：/api/oauth/usage 的 seven_day 只给
// 得出所有份里最早的那个刷新时间，用户看不出哪一份什么时候恢复。
//
// 这里只管「画哪几条、按什么顺序、哪些收进折叠行」，不碰 React。

type WeekKind = Extract<GatewayPlanKind, "subscription" | "pack" | "gift">;

// 分组顺序即显示顺序。enterprise 走项目用量，video 不按周计 —— 都不在这里。
const WEEK_KINDS: WeekKind[] = ["subscription", "pack", "gift"];

const KIND_SHORT: Record<WeekKind, string> = {
  subscription: "订阅",
  pack: "加量",
  gift: "赠送",
};

export type WeekGrant = GatewaySubscriptionPlan & {
  kind: WeekKind;
  week_utilization: number;
};

// 服务端认不出来源的额外额度，kind 原样填 role（llm_gateway#496），也就是
// "extra"。它不是用户自己买的，按赠送显示 —— 丢掉的话用量卡上就少一份。
function weekKind(p: GatewaySubscriptionPlan): WeekKind | null {
  if (p.kind === "extra") return "gift";
  return WEEK_KINDS.includes(p.kind as WeekKind) ? (p.kind as WeekKind) : null;
}

function toWeekGrant(p: GatewaySubscriptionPlan): WeekGrant | null {
  const kind = weekKind(p);
  if (p.pending || p.week_utilization == null || !kind) return null;
  return { ...p, kind, week_utilization: p.week_utilization };
}

export interface WeekGrantSplit {
  /** 常显在「5 小时」下面的那几条。 */
  pinned: WeekGrant[];
  /** 收进折叠行的那几条。 */
  folded: WeekGrant[];
}

/**
 * 把 plans 拆成常显和折叠两组。返回 null 表示没有可拆的数据（老服务端、只有
 * 排队中的、只有视频的），调用方退回单条「7 天」—— 和改动前一模一样。
 *
 * 常显的是订阅层；加量和赠送收起来。订阅已经过期、只剩加量/赠送时没有订阅层
 * 可以常显，这时它们直接显示，否则卡片上一条 7 天用量都没有。
 *
 * 同一类里保持服务端的顺序（valid_until 升序，也是先扣哪一份的顺序），客户端
 * 不重排 —— 理由同 PlanSections。
 */
export function splitWeekGrants(
  plans: GatewaySubscriptionPlan[] | undefined,
): WeekGrantSplit | null {
  const grants = (plans ?? [])
    .map(toWeekGrant)
    .filter((p): p is WeekGrant => p !== null);
  if (grants.length === 0) return null;
  const byKind = (kind: WeekKind) => grants.filter((p) => p.kind === kind);
  const subs = byKind("subscription");
  const rest = [...byKind("pack"), ...byKind("gift")];
  return subs.length > 0
    ? { pinned: subs, folded: rest }
    : { pinned: rest, folded: [] };
}

/**
 * 用量按厂商分组时（/api/oauth/usage 的 vendors，llm_gateway#503），某一组
 * 该画哪几份：plan 的 vendor 说明它算在哪一组里，没绑定的算「通用」（null）。
 * 服务端保证每份都有对应的组；万一没有，放进「通用」，再没有就放第一组 ——
 * 宁可放错组，也不能让一份额度从用量卡上消失。
 *
 * `vendor` 为 undefined 表示没有分组（老服务端），所有份都在这一组。
 */
export function plansInVendorGroup(
  plans: GatewaySubscriptionPlan[],
  vendor: string | null | undefined,
  groupVendors: (string | null)[],
): GatewaySubscriptionPlan[] {
  if (vendor === undefined) return plans;
  const home = (p: GatewaySubscriptionPlan) => {
    const own = p.vendor ?? null;
    if (groupVendors.includes(own)) return own;
    return groupVendors.includes(null) ? null : groupVendors[0];
  };
  return plans.filter((p) => home(p) === vendor);
}

/**
 * 一条的标题：「7 天 · 订阅」。用量按厂商分组时组标题已经写了厂商，这里不再
 * 重复；没有分组（老服务端）而 plans 又带厂商时，同一个人可能同时有 Claude
 * 和 GPT 两份订阅，这时写上厂商，否则两条分不清。
 */
export function weekGrantLabel(plan: WeekGrant, showVendor: boolean): string {
  const kind = KIND_SHORT[plan.kind];
  if (!showVendor) return `7 天 · ${kind}`;
  const vendor =
    plan.vendor_label || (plan.vendor ? vendorLabel(plan.vendor) : "通用");
  return `7 天 · ${vendor} ${kind}`;
}

/** 折叠行左边那串：「加量 ×2、赠送」。 */
export function foldedSummary(folded: WeekGrant[]): string[] {
  return WEEK_KINDS.map((kind) => {
    const n = folded.filter((p) => p.kind === kind).length;
    if (n === 0) return "";
    return n > 1 ? `${KIND_SHORT[kind]} ×${n}` : KIND_SHORT[kind];
  }).filter(Boolean);
}

export type WeekFooterTone = "muted" | "warn" | "danger";

/**
 * 每条下面那行时间：
 *   - 正常：「10/28 17:00 刷新」
 *   - 没有 week_resets_at：下次刷新前就到期了，写到期日 —— 写刷新时间是在
 *     许诺一份不会来的额度
 *   - 用满：「已用完 · … 恢复」，用户这时只关心什么时候能接着用
 */
export function weekGrantFooter(plan: WeekGrant): {
  text: string;
  tone: WeekFooterTone;
} {
  if (!plan.week_resets_at) {
    return {
      text: `${formatMonthDay(plan.valid_until)} 到期 · 不再刷新`,
      tone: "warn",
    };
  }
  const at = formatWeekReset(plan.week_resets_at);
  if (plan.week_utilization >= 100) {
    return { text: `已用完 · ${at} 恢复`, tone: "danger" };
  }
  return { text: `${at} 刷新`, tone: "muted" };
}

// 本地时区，「10/28 17:00」。和用量条的「x 重置」同一个格式。
export function formatWeekReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 本地时区，「10/26」。到期只到天，理由同 formatPlanDate。
function formatMonthDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
