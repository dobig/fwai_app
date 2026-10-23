// 加量包的购买规则：能买多大、能不能买、按哪个价显示。纯函数，没有状态。
//
// 规则全部来自服务端目录（GET /v1/plans 的 extra 块），这里只是读它。字段缺
// 失（老网关）时退回老规则：1–max_units 任选、没有前置条件、没有商务价。
//
// 这里**没有任何金额计算**。周期行上显示的是服务端给的「一个单位多少钱」
// 原样照搬（商务价取 business_rate 的那一份），不乘单位数、不打折。N 单位的
// 实付以结账页的报价为准。

import type {
  GatewayExtraCatalog,
  GatewayExtraEligibility,
} from "@/lib/api/llm-gateway";
import { vendorLabel } from "./planCatalog";

// 老网关不发目录时的上限，与服务端 extraMaxUnits 一致。
export const LEGACY_EXTRA_MAX_UNITS = 99;

export interface ExtraUnitRules {
  max: number;
  // 0 表示没有步长规则（老网关）：1..max 任选。
  step: number;
}

export function extraUnitRules(
  extra?: GatewayExtraCatalog | null,
): ExtraUnitRules {
  const max =
    extra?.max_units && extra.max_units > 0
      ? extra.max_units
      : LEGACY_EXTRA_MAX_UNITS;
  const step =
    extra?.bulk_step_units && extra.bulk_step_units > 0
      ? extra.bulk_step_units
      : 0;
  return { max, step };
}

/** 1..step 任选，再往上只能是 step 的整数倍，且不超过 max。 */
export function isValidExtraUnits(n: number, rules: ExtraUnitRules): boolean {
  if (!Number.isInteger(n) || n < 1 || n > rules.max) return false;
  if (rules.step > 0 && n > rules.step && n % rules.step !== 0) return false;
  return true;
}

/** 实际能买到的最大单位数。max_units 仍报 99，叠加步长规则后是 80。 */
export function maxExtraUnits(rules: ExtraUnitRules): number {
  if (rules.step <= 0 || rules.max <= rules.step) return rules.max;
  return Math.floor(rules.max / rules.step) * rules.step;
}

/** 大于步长之后可选的那几档（20 → [40, 60, 80]）。没有步长规则时为空。 */
export function bulkExtraSizes(rules: ExtraUnitRules): number[] {
  if (rules.step <= 0) return [];
  const out: number[] = [];
  for (let n = rules.step * 2; n <= rules.max; n += rules.step) out.push(n);
  return out;
}

/** 输入框的原文 → 合法单位数；不合法返回 null（按钮置灰并提示）。 */
export function parseExtraUnits(
  raw: string,
  rules: ExtraUnitRules,
): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return isValidExtraUnits(n, rules) ? n : null;
}

/**
 * 把任意值吸附到最近的合法单位数。失焦时用：用户敲了 25 不该卡在一个红字
 * 提示上，直接给他最近能买的那一档。两边一样近时往大取（30 → 40），和
 * Math.round 一致。非数字回到 1。
 */
export function snapExtraUnits(n: number, rules: ExtraUnitRules): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  const top = maxExtraUnits(rules);
  if (n >= top) return top;
  const whole = Math.round(n);
  if (rules.step <= 0 || whole <= rules.step) return Math.max(1, whole);
  return Math.round(n / rules.step) * rules.step;
}

/**
 * 输入框的上下箭头 / 方向键：在合法单位数之间走一格。20 往上是 40 而不是 21，
 * 40 往下是 20 而不是 39。
 */
export function stepExtraUnits(
  current: number,
  direction: 1 | -1,
  rules: ExtraUnitRules,
): number {
  const top = maxExtraUnits(rules);
  const from = snapExtraUnits(current, rules);
  let next = from + direction;
  if (rules.step > 0 && next > rules.step) {
    next =
      direction > 0
        ? Math.ceil(next / rules.step) * rules.step
        : Math.floor(next / rules.step) * rules.step;
  }
  return Math.min(top, Math.max(1, next));
}

/**
 * onChange 里拿到的新值如果是箭头步进出来的（与上一个值差 1）且不合法，
 * 就当成一次 stepExtraUnits；其余情况（用户在打字）原样保留，等失焦再吸附 ——
 * 打「40」的中途必然经过「4」，那时候吸附会把人打断。
 */
export function nextExtraUnitsInput(
  prevRaw: string,
  nextRaw: string,
  rules: ExtraUnitRules,
): string {
  const prev = Number(prevRaw);
  const next = Number(nextRaw);
  if (
    prevRaw.trim() !== "" &&
    nextRaw.trim() !== "" &&
    Number.isInteger(prev) &&
    Number.isInteger(next) &&
    Math.abs(next - prev) === 1 &&
    !isValidExtraUnits(next, rules)
  ) {
    return String(stepExtraUnits(prev, next > prev ? 1 : -1, rules));
  }
  return nextRaw;
}

/** 单位数规则的一句话说明，用于输入框下的提示和 invalid_extra_units 报错。 */
export function extraUnitsRuleText(rules: ExtraUnitRules): string {
  const bulk = bulkExtraSizes(rules);
  if (bulk.length === 0) return `请输入 1–${rules.max} 的整数`;
  return `可选 1–${rules.step}，或 ${bulk.join("、")}`;
}

// --- 能不能买 ----------------------------------------------------------------

/**
 * 买某一家的加量包时该看的那份目录：eligibility 换成这一家的。
 *
 * 加量包按厂商卖，能不能买、享不享商务价都要看同一家（或未绑定）的生效套餐，
 * 所以下面这些函数读到的 eligibility 必须先按厂商挑好。没有 vendor（老服务端，
 * 目录不列厂商）或目录没有 eligibility_by_vendor 时原样返回 —— 那边只有一份。
 * 有 eligibility_by_vendor 却没有这一家，就当「不知道」，不拿 Claude 那份顶替。
 */
export function extraForVendor(
  extra: GatewayExtraCatalog,
  vendor: string | undefined,
): GatewayExtraCatalog {
  if (!vendor || !extra.eligibility_by_vendor) return extra;
  return { ...extra, eligibility: extra.eligibility_by_vendor[vendor] };
}

/**
 * 不能买时给用户看的那句话；能买（或不知道）返回 null。
 *
 * 只认目录里的 eligibility。拿不到目录（老网关、网络失败）就当「不知道」，
 * 不拦 —— 服务端会在报价那一步再校验，最坏是一个能看懂的 409 提示。
 */
export function extraBlockedMessage(
  extra?: GatewayExtraCatalog | null,
  vendor?: string,
): string | null {
  const e = extra?.eligibility;
  if (!e || e.can_buy) return null;
  return (
    extraErrorMessage(e.reason ?? "", extra, e, vendor) ?? "暂时无法购买加量包"
  );
}

/**
 * 报价 / 下单被拒时的错误码 → 人话。不认识的码返回 null，调用方用原来的
 * 兜底文案。
 */
export function extraErrorMessage(
  code: string,
  extra?: GatewayExtraCatalog | null,
  eligibility?: GatewayExtraEligibility,
  vendor?: string,
): string | null {
  switch (code) {
    case "subscription_required":
      // 「赠送额度不算」要说出来：被赠送额度的用户手上明明有量，不说的话
      // 他会以为自己算是有套餐的。按厂商卖时还要说是哪一家：手上有 Claude
      // 套餐的人买 GPT 加量包被拒，只说「先订阅套餐」他会以为是服务端坏了。
      return vendor
        ? `需要先订阅 ${vendorLabel(vendor)} 套餐才能购买 ${vendorLabel(vendor)} 加量包（赠送额度不算）`
        : "需要先订阅套餐才能购买加量包（赠送额度不算）";
    case "extra_pack_limit": {
      const limit = extra?.max_concurrent_paid_packs ?? 2;
      const held = eligibility?.active_paid_packs;
      return held != null && held > 0
        ? `已持有 ${held} 个加量包，最多同时持有 ${limit} 个，等其中一个到期后再买`
        : `最多同时持有 ${limit} 个加量包，等其中一个到期后再买`;
    }
    case "invalid_extra_units":
      return `加量包单位数不可用：${extraUnitsRuleText(extraUnitRules(extra))}`;
  }
  return null;
}

// --- 价格 --------------------------------------------------------------------

export interface ExtraPeriodPrice {
  /** **一个单位**、这个周期的实付（micro-USD），服务端原值。 */
  chargeMicros: number;
  /** 同一个单位按原价是多少。商务价时比 chargeMicros 高。 */
  listMicros: number;
  businessRate: boolean;
}

/**
 * N 个单位时，某个周期每单位的显示价。单位数只决定用不用商务价，不参与
 * 乘法。商务价只在三件事同时成立时用：服务端说这个
 * 用户享受（eligibility.business_rate）、单位数是 unit_step 的整数倍、这个
 * 周期出现在 business_rate.prices 里（服务端只列按月的周期）。
 *
 * 拿不到目录、或目录里没有这个周期，返回 null —— 那就不显示价格，和老版本
 * 一样等结账页的报价。
 */
export function extraPeriodPrice(
  extra: GatewayExtraCatalog | null | undefined,
  units: number,
  periodKey: string,
): ExtraPeriodPrice | null {
  if (!extra || !Number.isInteger(units) || units < 1) return null;
  const rate = extra.business_rate;
  if (
    rate &&
    extra.eligibility?.business_rate &&
    rate.unit_step > 0 &&
    units % rate.unit_step === 0
  ) {
    const p = rate.prices?.find((x) => x.period === periodKey);
    if (p) {
      return {
        chargeMicros: p.charge_micros,
        listMicros: p.list_micros,
        businessRate: true,
      };
    }
  }
  const list = extra.prices?.find((x) => x.period === periodKey);
  if (!list) return null;
  return {
    chargeMicros: list.charge_micros,
    listMicros: list.list_micros,
    businessRate: false,
  };
}

/** discount_bps → 角标文案。5000 是「半价」，其他按「X折」。 */
export function businessRateLabel(discountBps: number): string {
  if (discountBps === 5000) return "半价";
  const tenths = discountBps / 1000;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}折`;
}
