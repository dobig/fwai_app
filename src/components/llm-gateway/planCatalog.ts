// 购买和账号屏共用的显示格式化。从 LlmGatewaySubscriptionDock 抽出来的纯函数，
// 让 2000+ 行的主体不再继续长，也让这些规则能被单独测。
//
// 这里**没有任何付款金额的计算**，也**没有陈述套餐规则的文案**。实付金额一律
// 来自服务端的报价（见 fetchPlanQuote）；档位描述、倍数、周期名、能不能买的
// 原因、结账页说明这些句子也都由服务端写好下发（网关 CONTRACT「Display
// copy」）—— 规则一变就要跟着改的字放在客户端，等于每次调规则都得发一版 app。
// 本文件只负责「这个数字怎么显示」和「把服务端的占位符填上」。

import type {
  GatewaySubscriptionStatus,
  GatewayVendorDetail,
} from "@/lib/api/llm-gateway";

/**
 * 把服务端文案里的 {name} 占位符换成 values 里的值。没给值的占位符原样留着
 * —— 宁可让用户看到一个花括号，也不要悄悄吞掉一半句子。text 缺失（老服务端）
 * 返回空串，调用方据此不渲染那一行。
 *
 * 日期由调用方先用 formatPlanDate 格式化再传进来：服务端不知道用户在哪个
 * 时区，所以日期在文案里只是占位符。
 */
export function fillServerText(
  text: string | undefined,
  values: Record<string, string | number | undefined> = {},
): string {
  if (!text) return "";
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = values[name];
    return v === undefined || v === "" ? whole : String(v);
  });
}

// 厂商的显示名。目录到手时用服务端给的（vendor_details），这是购买流程里的
// 正路；这张表只是兜底 —— 账号屏的厂商标签、开转发时的提示都可能在目录还没
// 拉下来时出现。线上的 openai 对用户说 GPT：用户认的是模型，不是公司。
// 不认识的值原样显示，服务端以后加一家时至少不会显示成空白。
const VENDOR_FALLBACK_LABELS: Record<string, string> = {
  flex: "Flex",
  claude: "Claude",
  openai: "GPT",
};

export function vendorLabel(
  vendor: string,
  details?: GatewayVendorDetail[],
): string {
  return (
    details?.find((d) => d.id === vendor)?.label ??
    VENDOR_FALLBACK_LABELS[vendor] ??
    vendor
  );
}

/**
 * 账号卡片右上角那个档位名，服务端写好的 label。老服务端没有时退回 tier
 * 本身 —— 不好看但不说错话。
 */
export function subscriptionLabel(sub?: GatewaySubscriptionStatus): string {
  if (!sub?.tier) return "会员";
  return sub.label || sub.tier;
}

// micro-USD → 美元。1e6 = $1。整份客户端只有这一个换算入口 —— 两处各自
// 四舍五入的话，同一笔钱在两屏上会显示成不同的数字。
//
// 小数位按金额大小自适应：$66.67 的抵扣额抹成 $67 会让用户对不上账，
// 而额度上限那种整数金额后面拖两个 .00 只是噪音。
export function formatMicrosUSD(micros: number): string {
  const usd = micros / 1_000_000;
  if (Number.isInteger(usd)) return `$${usd}`;
  return `$${usd.toFixed(2)}`;
}

// 到期日按用户本地时区显示，**只到天**。精确到小时只会引来「到底几点过期」
// 的追问，而那个答案客户端也给不准（服务端按 UTC 的某个时刻算）。
export function formatPlanDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN");
}
