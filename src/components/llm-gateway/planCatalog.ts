// 档位目录与展示格式化。从 LlmGatewaySubscriptionDock 抽出来的纯数据/纯函数，
// 让 2000+ 行的主体不再继续长，也让这些规则能被单独测。
//
// 这里**没有任何付款金额的计算**。实付金额一律来自服务端的报价（见
// fetchPlanQuote），本文件只负责「这个档位叫什么」「这个数字怎么显示」。

// Plans mirror the gateway seed SKUs, named by their monthly price. The 5h /
// weekly quota windows shown here mirror the server derivation (default 1×/5×
// of price; business overrides with 2×/10×) — the server stays authoritative.
//
// **这两个额度字段永远不直接显示给用户。** 它们只用来推导「N× Starter」这样的
// 相对描述（见 tierBlurb / extraUnitsBlurb）。用户不需要知道我们的窗口是多少
// 美元，那个数字对他毫无意义，只会引出「$100 能用多久」这类无法回答的追问。
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

// 一份额度是 Starter 的几倍。倍数是**精确**的而非近似：starter 是 5h $20 /
// 周 $100，pro 两项各 5×，business 因为服务端给了 2×/10× 系数而是 20×，
// 加量包 1 单位 = $20/月 = 恰好 1×。两个窗口的倍数一致，所以取 5h 的即可。
//
// 从字段推导而不是写死字符串：以后调价改系数，文案自动跟随。
export function starterMultiple(usage5hUSD: number): number {
  const base = TIERS[0].usage5hUSD;
  return base > 0 ? usage5hUSD / base : 0;
}

// 选档卡片里的一行小字。三列窄卡片，只放得下一个短语。
// Starter 是基准，说倍数没有意义（「1× Starter」是废话），改说它是什么。
export function tierBlurb(tier: PlanTier): string {
  if (tier.id === TIERS[0].id) return "Starter";
  return `${formatMultiple(starterMultiple(tier.usage5hUSD))}× Starter 用量`;
}

// 选周期页的整行说明，比卡片宽得多，Starter 这里能把「适合谁」说完整 ——
// 那句话正是大多数用户唯一需要读的一句。
export function tierDescription(tier: PlanTier): string {
  if (tier.id === TIERS[0].id) return "Starter · 适合大部分普通用户";
  return tierBlurb(tier);
}

// 倍数取整显示。目录三档都是整数倍（5×/20×），小数分支给两种情况兜底：将来
// 调系数，以及账户页把 admin 发的任意额度也加进总和时（那个和几乎必然不是整数）。
export function formatMultiple(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function planLabel(tier?: string): string {
  if (!tier) return "会员";
  // custom 不再能被购买（服务端只认目录三档），但 admin 直接发放和兑换码激活
  // 得来的 grant 仍以 tier: "custom" 回读（NULL plan_id 的兜底），账号屏要显示
  // 得出来。文案是「专属额度」而非「自选」—— 用户已经没有「自选」这个动作了，
  // 那份额度是发给他的。
  if (tier === "custom") return "专属额度";
  if (tier === "extra") return "加量包";
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
