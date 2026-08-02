// 档位目录与展示格式化。从 LlmGatewaySubscriptionDock 抽出来的纯数据/纯函数，
// 让 2000+ 行的主体不再继续长，也让这些规则能被单独测。
//
// 这里**没有任何付款金额的计算**。实付金额一律来自服务端的报价（见
// fetchPlanQuote），本文件只负责「这个档位叫什么」「这个数字怎么显示」。

// Plans mirror the gateway seed SKUs, named by their monthly price. The 5h /
// weekly quota windows shown here mirror the server derivation (default 1×/5×
// of price; business overrides with 2×/10×) — the server stays authoritative.
export interface PlanTier {
  id: string;
  label: string;
  priceUSD: number;
  usage5hUSD: number;
  usageWeekUSD: number;
}

export const TIERS: PlanTier[] = [
  {
    id: "starter",
    label: "$20",
    priceUSD: 20,
    usage5hUSD: 20,
    usageWeekUSD: 100,
  },
  {
    id: "pro",
    label: "$100",
    priceUSD: 100,
    usage5hUSD: 100,
    usageWeekUSD: 500,
  },
  {
    id: "business",
    label: "$200",
    priceUSD: 200,
    usage5hUSD: 400,
    usageWeekUSD: 2000,
  },
];

// Self-serve custom plan: buyer names a whole-dollar MONTHLY price and the
// quota windows derive from it (5h = 1× price, week = 5× price). Bounds mirror
// the server ($10–$199, and always below the $200 tier).
export const CUSTOM_TIER_ID = "custom";
export const CUSTOM_MIN_USD = 10;
export const CUSTOM_MAX_USD = 199;

export function parseCustomPrice(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < CUSTOM_MIN_USD || n > CUSTOM_MAX_USD) {
    return null;
  }
  return n;
}

export function planLabel(tier?: string): string {
  if (!tier) return "会员";
  if (tier === CUSTOM_TIER_ID) return "自选";
  const known = TIERS.find((t) => t.id === tier);
  return known ? known.label : tier.charAt(0).toUpperCase() + tier.slice(1);
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
