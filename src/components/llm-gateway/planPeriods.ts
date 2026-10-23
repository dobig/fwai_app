// 周期选项的显示信息：叫什么、多少天、对谁开放 —— 全部读服务端目录的
// periods[]。
//
// 这里**没有任何价格**，也没有周期名。周期的总价、月均价、省多少来自服务端的
// GET /v1/plans（见 fetchPlanCatalog），实付来自 quote。这个文件曾经镜像过
// 一份服务端的折扣表（num/den/discount）在本地乘出预览价，后来两边的折扣
// 对不上 —— 只要客户端有一份自己的价目表，这种漂移就迟早会发生，所以删了。
// 周期名和天数后来也改成读目录，理由一样。

import type { GatewayCatalogPeriod } from "@/lib/api/llm-gateway";

export const DEFAULT_PERIOD = "1m";

/**
 * 一个周期的名字和天数。目录里没有这个 key（不该发生）或老服务端没发 label
 * 时，名字退回 key 本身、天数为 undefined —— 难看但不说错话。
 */
export function periodInfo(
  periods: GatewayCatalogPeriod[] | undefined,
  key: string,
): { label: string; days?: number } {
  const p = periods?.find((x) => x.key === key);
  return { label: p?.label || key, days: p?.days };
}

/**
 * 这个厂商能不能买这个周期，按服务端 periods[].vendors（Claude 最长一个月，
 * GPT 不限）。服务端没发 vendors（老网关）或没传厂商（老网关不按厂商卖）时
 * 一律开放 —— 那边本来就不限，真被拒了也只是一个 period_not_available。
 */
export function periodOpenTo(
  periods: GatewayCatalogPeriod[],
  key: string,
  vendor: string | undefined,
): boolean {
  const vendors = periods.find((p) => p.key === key)?.vendors;
  if (!vendor || !vendors) return true;
  return vendors.includes(vendor);
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
