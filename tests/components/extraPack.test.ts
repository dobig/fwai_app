import { describe, it, expect } from "vitest";
import {
  bulkExtraSizes,
  businessRateLabel,
  extraBlockedMessage,
  extraErrorMessage,
  extraForVendor,
  extraPeriodPrice,
  extraUnitRules,
  extraUnitsRuleText,
  isValidExtraUnits,
  maxExtraUnits,
  nextExtraUnitsInput,
  parseExtraUnits,
  snapExtraUnits,
  stepExtraUnits,
} from "@/components/llm-gateway/extraPack";
import type { GatewayExtraCatalog } from "@/lib/api/llm-gateway";

// 服务端目录 extra 块的样本，数字取自 llm_gateway 的 pricesFor /
// businessRatePrices：1 单位 $20/月，商务价半价、只列按月的周期。
const M = 1_000_000;
function price(period: string, charge: number, list = charge) {
  return {
    period,
    charge_micros: charge * M,
    list_micros: list * M,
    savings_micros: (list - charge) * M,
    per_unit_micros: 0,
    per_unit: "month" as const,
  };
}
function catalog(
  patch: Partial<GatewayExtraCatalog> = {},
): GatewayExtraCatalog {
  return {
    unit_price_micros: 20 * M,
    max_units: 99,
    prices: [
      price("1w", 5),
      price("2w", 10),
      price("3w", 15),
      price("1m", 20),
      price("3m", 60),
      price("6m", 120),
      price("12m", 240),
    ],
    bulk_step_units: 20,
    requires_plan: true,
    max_concurrent_paid_packs: 2,
    business_rate: {
      plan_id: "business",
      discount_bps: 5000,
      unit_step: 20,
      month_periods_only: true,
      prices: [
        price("1m", 10, 20),
        price("3m", 30, 60),
        price("6m", 60, 120),
        price("12m", 120, 240),
      ],
    },
    eligibility: {
      plan_in_force: true,
      business_rate: false,
      active_paid_packs: 0,
      can_buy: true,
    },
    ...patch,
  };
}

describe("加量包单位数规则", () => {
  const rules = extraUnitRules(catalog());
  const legacy = extraUnitRules(undefined);

  it("1–20 任选，20 以上只有 40/60/80", () => {
    const valid = [];
    for (let n = 0; n <= 100; n++)
      if (isValidExtraUnits(n, rules)) valid.push(n);
    expect(valid).toEqual([
      ...Array.from({ length: 20 }, (_, i) => i + 1),
      40,
      60,
      80,
    ]);
    // max_units 仍报 99（兼容老客户端），叠加步长后实际封顶 80。
    expect(maxExtraUnits(rules)).toBe(80);
    expect(bulkExtraSizes(rules)).toEqual([40, 60, 80]);
    expect(extraUnitsRuleText(rules)).toBe("可选 1–20，或 40、60、80");
  });

  it("老网关没有 bulk_step_units：退回 1–99 任选", () => {
    expect(legacy).toEqual({ max: 99, step: 0 });
    expect(isValidExtraUnits(57, legacy)).toBe(true);
    expect(maxExtraUnits(legacy)).toBe(99);
    expect(bulkExtraSizes(legacy)).toEqual([]);
    expect(extraUnitsRuleText(legacy)).toBe("请输入 1–99 的整数");
  });

  it("解析输入框原文", () => {
    expect(parseExtraUnits("20", rules)).toBe(20);
    expect(parseExtraUnits("40", rules)).toBe(40);
    expect(parseExtraUnits("25", rules)).toBeNull();
    expect(parseExtraUnits("99", rules)).toBeNull();
    expect(parseExtraUnits("", rules)).toBeNull();
    expect(parseExtraUnits("1.5", rules)).toBeNull();
  });

  it("吸附到最近的一档", () => {
    expect(snapExtraUnits(0, rules)).toBe(1);
    expect(snapExtraUnits(Number.NaN, rules)).toBe(1);
    expect(snapExtraUnits(7, rules)).toBe(7);
    expect(snapExtraUnits(21, rules)).toBe(20);
    expect(snapExtraUnits(29, rules)).toBe(20);
    expect(snapExtraUnits(30, rules)).toBe(40);
    expect(snapExtraUnits(55, rules)).toBe(60);
    expect(snapExtraUnits(99, rules)).toBe(80);
    expect(snapExtraUnits(500, rules)).toBe(80);
    expect(snapExtraUnits(150, legacy)).toBe(99);
  });

  it("箭头步进跳过买不到的数", () => {
    expect(stepExtraUnits(19, 1, rules)).toBe(20);
    expect(stepExtraUnits(20, 1, rules)).toBe(40);
    expect(stepExtraUnits(40, -1, rules)).toBe(20);
    expect(stepExtraUnits(80, 1, rules)).toBe(80);
    expect(stepExtraUnits(1, -1, rules)).toBe(1);
    expect(stepExtraUnits(20, 1, legacy)).toBe(21);
  });

  it("onChange：箭头步进出的非法值跳一档，打字的中途原样保留", () => {
    expect(nextExtraUnitsInput("20", "21", rules)).toBe("40");
    expect(nextExtraUnitsInput("40", "39", rules)).toBe("20");
    expect(nextExtraUnitsInput("19", "20", rules)).toBe("20");
    // 打「40」的中途经过「4」，打「25」会先停在红字上，等失焦再吸附。
    expect(nextExtraUnitsInput("", "4", rules)).toBe("4");
    expect(nextExtraUnitsInput("2", "25", rules)).toBe("25");
    expect(nextExtraUnitsInput("1", "", rules)).toBe("");
  });
});

describe("加量包能不能买", () => {
  it("能买或不知道时不拦", () => {
    expect(extraBlockedMessage(catalog())).toBeNull();
    expect(extraBlockedMessage(null)).toBeNull();
    expect(extraBlockedMessage(catalog({ eligibility: undefined }))).toBeNull();
  });

  it("没有付费套餐：说清赠送额度不算", () => {
    const msg = extraBlockedMessage(
      catalog({
        eligibility: {
          plan_in_force: false,
          business_rate: false,
          active_paid_packs: 0,
          can_buy: false,
          reason: "subscription_required",
        },
      }),
    );
    expect(msg).toBe("需要先订阅套餐才能购买加量包（赠送额度不算）");
  });

  it("到上限：说出已持有几个、上限几个", () => {
    const msg = extraBlockedMessage(
      catalog({
        eligibility: {
          plan_in_force: true,
          business_rate: false,
          active_paid_packs: 2,
          can_buy: false,
          reason: "extra_pack_limit",
        },
      }),
    );
    expect(msg).toBe(
      "已持有 2 个加量包，最多同时持有 2 个，等其中一个到期后再买",
    );
  });

  it("服务端错误码 → 人话；不认识的返回 null", () => {
    expect(extraErrorMessage("extra_pack_limit")).toBe(
      "最多同时持有 2 个加量包，等其中一个到期后再买",
    );
    expect(extraErrorMessage("invalid_extra_units", catalog())).toBe(
      "加量包单位数不可用：可选 1–20，或 40、60、80",
    );
    expect(extraErrorMessage("create_payment_failed")).toBeNull();
  });
});

// 按厂商卖之后，能不能买、享不享商务价都看同一家的那一份 eligibility。
describe("按厂商挑加量包的 eligibility", () => {
  const gptNoPlan = {
    plan_in_force: false,
    business_rate: false,
    active_paid_packs: 0,
    can_buy: false,
    reason: "subscription_required",
  };
  const byVendor = catalog({
    eligibility_by_vendor: {
      claude: catalog().eligibility!,
      openai: gptNoPlan,
    },
  });

  it("换成这一家的那一份，不读老字段（那是 Claude 的）", () => {
    expect(extraForVendor(byVendor, "openai").eligibility).toEqual(gptNoPlan);
    expect(extraBlockedMessage(extraForVendor(byVendor, "claude"))).toBeNull();
  });

  it("目录里没有这一家时当「不知道」，不拿 Claude 那份顶替", () => {
    expect(extraForVendor(byVendor, "gemini").eligibility).toBeUndefined();
  });

  it("没选厂商或老服务端没有 eligibility_by_vendor 时原样返回", () => {
    expect(extraForVendor(byVendor, undefined)).toBe(byVendor);
    const legacy = catalog();
    expect(extraForVendor(legacy, "openai")).toBe(legacy);
  });

  it("没有这一家的套餐：说清要先订阅哪一家", () => {
    expect(
      extraBlockedMessage(extraForVendor(byVendor, "openai"), "openai"),
    ).toBe("需要先订阅 GPT 套餐才能购买 GPT 加量包（赠送额度不算）");
  });
});

describe("加量包显示价", () => {
  const business = catalog({
    eligibility: {
      plan_in_force: true,
      business_rate: true,
      active_paid_packs: 0,
      can_buy: true,
    },
  });

  it("Business 用户、20 的整数倍、按月：取商务价，不乘单位数", () => {
    expect(extraPeriodPrice(business, 20, "1m")).toEqual({
      chargeMicros: 10 * M,
      listMicros: 20 * M,
      businessRate: true,
    });
    expect(extraPeriodPrice(business, 40, "12m")).toEqual({
      chargeMicros: 120 * M,
      listMicros: 240 * M,
      businessRate: true,
    });
  });

  it("按周、或不是 20 的整数倍：原价", () => {
    expect(extraPeriodPrice(business, 20, "1w")).toEqual({
      chargeMicros: 5 * M,
      listMicros: 5 * M,
      businessRate: false,
    });
    expect(extraPeriodPrice(business, 19, "1m")).toEqual({
      chargeMicros: 20 * M,
      listMicros: 20 * M,
      businessRate: false,
    });
  });

  it("不是 Business：原价", () => {
    expect(extraPeriodPrice(catalog(), 20, "1m")?.businessRate).toBe(false);
    expect(extraPeriodPrice(catalog(), 20, "1m")?.chargeMicros).toBe(20 * M);
  });

  it("没有目录：不显示价格", () => {
    expect(extraPeriodPrice(null, 20, "1m")).toBeNull();
  });

  it("折扣角标", () => {
    expect(businessRateLabel(5000)).toBe("半价");
    expect(businessRateLabel(8000)).toBe("8折");
  });
});
