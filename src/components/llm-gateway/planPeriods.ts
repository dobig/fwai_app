// 周期选项与**预览**价格。
//
// 这套逻辑在只有「买套餐」一个动作时还能和服务端对得上。加了换档之后对不上
// 了 —— 抵扣额取决于旧档实付、已用天数、向上取整规则，客户端不可能算准。
// 而两套算法只要有一处不一致，用户看到的价格和实际扣款就会不同，这是最伤
// 信任的一类 bug。
//
// 所以本文件里的所有金额一律是**预览**：档位卡片和周期列表上「这一档大概
// 多少钱」的参考数字。**实付金额一律来自服务端**（结账页取 quote 的
// amount_due_micros，二维码页取下单响应的 amount_credits）。
//
// 那为什么不干脆删掉？因为老网关没有 quote 端点，那种情况下整个换档 UI 都
// 不出现，购买流程退回旧形态，本地计算仍是唯一的价格来源。所以只能降级，
// 不能删。

// 镜像服务端的 planPeriods 表。`num/den` 是这个周期占月费的比例：一周是
// 月费的 1/4。周选项只对加量包开放（自选金额档已删除，订阅层一律按月起售），
// 且停在 3 周 —— 第 4 周的价格和 1 个月一样，但只给 28 天而不是 30 天。
export interface PlanPeriod {
  key: string;
  label: string;
  days: number;
  num: number;
  den: number;
  discount: number;
  extraOnly?: boolean;
}

export const PERIODS: PlanPeriod[] = [
  {
    key: "1w",
    label: "1 周",
    days: 7,
    num: 1,
    den: 4,
    discount: 1,
    extraOnly: true,
  },
  {
    key: "2w",
    label: "2 周",
    days: 14,
    num: 2,
    den: 4,
    discount: 1,
    extraOnly: true,
  },
  {
    key: "3w",
    label: "3 周",
    days: 21,
    num: 3,
    den: 4,
    discount: 1,
    extraOnly: true,
  },
  { key: "1m", label: "1 个月", days: 30, num: 1, den: 1, discount: 1 },
  { key: "3m", label: "3 个月", days: 90, num: 3, den: 1, discount: 1 },
  { key: "6m", label: "6 个月", days: 180, num: 6, den: 1, discount: 0.95 },
  { key: "12m", label: "12 个月", days: 360, num: 12, den: 1, discount: 0.9 },
];

export const DEFAULT_PERIOD = "1m";

export function findPeriod(key: string): PlanPeriod {
  return PERIODS.find((p) => p.key === key) ?? PERIODS[3];
}

/** 哪些周期对哪种购买开放。纯规则，不是钱。 */
export function periodsFor(asExtra: boolean): PlanPeriod[] {
  return PERIODS.filter((p) => !p.extraOnly || asExtra);
}

/** 折扣角标。这是**营销文案**不是金额，留在本地没有对不上账的风险。 */
export function periodDiscountLabel(period: PlanPeriod): string {
  if (period.discount === 0.9) return "9折";
  if (period.discount === 0.95) return "95折";
  return "";
}

/**
 * 档位卡片/周期列表上的预览总价。
 *
 * **不参与付款。** 用户还没选周期时总得先看到点什么，这个数字就是那个
 * 「大概多少钱」。真正扣多少由服务端说了算 —— 抵扣、排队、按天折算都在
 * 服务端，客户端算出来的这个值在换档场景下必然偏高（它不含任何抵扣）。
 *
 * 保留分位精度：95%/90% 折扣和周的 1/4 都可能落到小数上
 * （$20 × 12 × 0.9 = $216，但 $20 ÷ 4 = $5、$100 × 0.95 = $95 这类组合里
 * 加量包的多单位价格会出现分位）。
 */
export function previewTotalUSD(priceUSD: number, period: PlanPeriod): number {
  return (
    Math.round(((priceUSD * period.num) / period.den) * period.discount * 100) /
    100
  );
}

/**
 * 周期行上的单价预览。月周期按月算，周周期按周算 —— 把周付的「$3.75/月」
 * 和月付的「$15/月」摆在一起，看着像打了 4 折而不是买得短。
 *
 * 同样**不参与付款**。
 */
export function previewUnitUSD(
  priceUSD: number,
  period: PlanPeriod,
): { amount: number; unit: string } {
  if (period.den !== 1) {
    const weeks = period.num;
    return {
      amount:
        Math.round((previewTotalUSD(priceUSD, period) / weeks) * 100) / 100,
      unit: "周",
    };
  }
  return {
    amount: Math.round(priceUSD * period.discount * 100) / 100,
    unit: "月",
  };
}
