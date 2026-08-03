import { describe, it, expect } from "vitest";
import {
  PERIODS,
  findPeriod,
  periodDiscountLabel,
  periodsFor,
  previewTotalUSD,
  previewUnitUSD,
} from "@/components/llm-gateway/planPeriods";

// 这些函数算的全是**预览价**——档位卡片上「这一档大概多少钱」的参考数字。
// 实付一律取服务端。这里盯的是预览本身别显示错，以及周期规则（哪些档位能
// 买周付）没被改坏。
describe("planPeriods 预览价", () => {
  it("周付只对加量包开放", () => {
    // 自选金额档已删除，订阅层一律按月起售；周期档留给加量包。
    // 第 4 周的价格和 1 个月一样但只给 28 天，所以周选项停在 3 周。
    expect(periodsFor(true).map((p) => p.key)).toEqual([
      "1w",
      "2w",
      "3w",
      "1m",
      "3m",
      "6m",
      "12m",
    ]);
    expect(periodsFor(false).map((p) => p.key)).toEqual([
      "1m",
      "3m",
      "6m",
      "12m",
    ]);
  });

  it("折扣角标只在 6m/12m 出现", () => {
    const labels = PERIODS.map((p) => [p.key, periodDiscountLabel(p)]);
    expect(labels).toEqual([
      ["1w", ""],
      ["2w", ""],
      ["3w", ""],
      ["1m", ""],
      ["3m", ""],
      ["6m", "95折"],
      ["12m", "9折"],
    ]);
  });

  it("保留分位精度", () => {
    // 折扣和周的 1/4 都会落到小数上，抹掉分位的话预览价和服务端的目录价
    // 对不上。加量包按 $20/单位定价，多单位配上周期后同样出分位。
    expect(previewTotalUSD(20, findPeriod("1w"))).toBe(5);
    expect(previewTotalUSD(60, findPeriod("6m"))).toBe(342);
    expect(previewTotalUSD(100, findPeriod("6m"))).toBe(570);
  });

  it("周付按周报单价，不按月", () => {
    // 把周付的「$5/月」和月付的「$20/月」摆在一起，看着像打了 4 折
    // 而不是买得短。
    expect(previewUnitUSD(20, findPeriod("1w"))).toEqual({
      amount: 5,
      unit: "周",
    });
    expect(previewUnitUSD(100, findPeriod("12m"))).toEqual({
      amount: 90,
      unit: "月",
    });
  });

  it("未知周期退回 1 个月，不返回 undefined", () => {
    // 服务端将来加了新周期、老客户端不认识时，宁可显示成月付也不要崩。
    expect(findPeriod("99y").key).toBe("1m");
  });
});
