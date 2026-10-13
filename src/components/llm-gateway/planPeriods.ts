// 周期选项的**显示信息**：叫什么、多少天、对谁开放。
//
// 这里**没有任何价格**。周期的总价、月均价、省多少全部来自服务端的
// GET /v1/plans（见 fetchPlanCatalog），实付来自 quote。这个文件曾经镜像过
// 一份服务端的折扣表（num/den/discount）在本地乘出预览价，后来两边的折扣
// 对不上 —— 只要客户端有一份自己的价目表，这种漂移就迟早会发生，所以删了。

// 周选项只对加量包开放（订阅层一律按月起售），且停在 3 周 —— 第 4 周的价格
// 和 1 个月一样，但只给 28 天而不是 30 天。
export interface PlanPeriod {
  key: string;
  label: string;
  days: number;
  extraOnly?: boolean;
}

export const PERIODS: PlanPeriod[] = [
  { key: "1w", label: "1 周", days: 7, extraOnly: true },
  { key: "2w", label: "2 周", days: 14, extraOnly: true },
  { key: "3w", label: "3 周", days: 21, extraOnly: true },
  { key: "1m", label: "1 个月", days: 30 },
  { key: "3m", label: "3 个月", days: 90 },
  { key: "6m", label: "6 个月", days: 180 },
  { key: "12m", label: "12 个月", days: 360 },
];

export const DEFAULT_PERIOD = "1m";

export function findPeriod(key: string): PlanPeriod {
  return PERIODS.find((p) => p.key === key) ?? PERIODS[3];
}

/**
 * 折扣角标，按服务端 periods[] 的 discount_bps 格式化：9000 → 「9折」，
 * 9500 → 「95折」，不打折返回空串。只是把服务端给的折扣率换个写法，不参与
 * 任何金额。
 */
export function periodDiscountLabel(discountBps?: number): string {
  if (!discountBps || discountBps >= 10000) return "";
  const tenths = discountBps / 1000;
  return Number.isInteger(tenths) ? `${tenths}折` : `${discountBps / 100}折`;
}
