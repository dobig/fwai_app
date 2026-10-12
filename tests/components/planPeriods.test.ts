import { describe, it, expect } from "vitest";
import {
  findPeriod,
  periodDiscountLabel,
} from "@/components/llm-gateway/planPeriods";

// 这里只剩周期的显示信息。价格全部来自服务端，本文件不再有任何金额。
describe("planPeriods", () => {
  it("折扣角标按服务端的 discount_bps 格式化", () => {
    expect(periodDiscountLabel(9000)).toBe("9折");
    expect(periodDiscountLabel(9500)).toBe("95折");
    // 不打折、或老服务端没给 —— 不画角标。
    expect(periodDiscountLabel(10000)).toBe("");
    expect(periodDiscountLabel(undefined)).toBe("");
  });

  it("未知周期退回 1 个月，不返回 undefined", () => {
    // 服务端将来加了新周期、老客户端不认识时，宁可显示成月付也不要崩。
    expect(findPeriod("99y").key).toBe("1m");
  });
});
