// 加量包的购买规则：能买多大、能不能买。纯函数，没有状态。
//
// 规则全部来自服务端目录（GET /v1/plans 的 extra 块），这里只是读它。字段缺
// 失（老网关）时退回老规则：1–max_units 任选、没有前置条件。说明规则的句子
// （单位数怎么选、为什么买不了）也是服务端写好的，这里不拼。
//
// 这里**没有任何金额计算**。周期行上显示的是服务端给的「一个单位多少钱」
// 原样照搬，不乘单位数、不打折。N 单位的实付以结账页的报价为准。

import type {
  GatewayExtraCatalog,
  GatewayPurchaseCopy,
} from "@/lib/api/llm-gateway";

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

// --- 能不能买 ----------------------------------------------------------------

/**
 * 买某一家的加量包时该看的那份目录：eligibility 换成这一家的。
 *
 * 加量包按厂商卖，能不能买要看同一家（或未绑定）的生效套餐，
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
 * 这一家的加量包现在买不了时横幅上的那句话；能买（或不知道）返回 null。
 *
 * 句子是服务端按这个用户的状态写好的（copy.by_vendor[v].extra_blocked），
 * 客户端不再自己翻译 reason：「赠送额度不算」「最多同时持有几个」这些说法都是
 * 规则，规则在服务端。服务端说不能买（eligibility.can_buy=false）却没给句子
 * 时只说一句不承诺原因的话，按钮照样置灰。拿不到目录（老网关、网络失败）
 * 就当「不知道」，不拦 —— 服务端会在报价那一步再校验。
 */
export function extraBlockedText(
  extra: GatewayExtraCatalog | null | undefined,
  copy: GatewayPurchaseCopy | undefined,
  vendor: string | undefined,
): string | null {
  const text = vendor ? copy?.by_vendor?.[vendor]?.extra_blocked : undefined;
  if (text) return text;
  if (extra?.eligibility && !extra.eligibility.can_buy) {
    return "暂时无法购买加量包";
  }
  return null;
}
