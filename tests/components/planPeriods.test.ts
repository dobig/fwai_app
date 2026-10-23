import { describe, it, expect } from "vitest";
import {
  periodDiscountLabel,
  periodInfo,
} from "@/components/llm-gateway/planPeriods";

// 这里只剩把服务端的周期信息读出来。价格和周期名全部来自服务端。
describe("planPeriods", () => {
  it("折扣角标按服务端的 discount_bps 格式化", () => {
    expect(periodDiscountLabel(9000)).toBe("9折");
    expect(periodDiscountLabel(9500)).toBe("95折");
    // 不打折、或老服务端没给 —— 不画角标。
    expect(periodDiscountLabel(10000)).toBe("");
    expect(periodDiscountLabel(undefined)).toBe("");
  });

  it("周期名和天数取服务端目录，取不到时名字退回 key", () => {
    const periods = [
      {
        key: "1m",
        label: "整整一个月",
        days: 30,
        discount_bps: 10000,
        extra_only: false,
      },
      { key: "1w", days: 7, discount_bps: 10000, extra_only: true },
    ];
    expect(periodInfo(periods, "1m")).toEqual({
      label: "整整一个月",
      days: 30,
    });
    // 老服务端不发 label：显示 key，难看但不说错话。
    expect(periodInfo(periods, "1w")).toEqual({ label: "1w", days: 7 });
    expect(periodInfo(periods, "99y")).toEqual({
      label: "99y",
      days: undefined,
    });
    expect(periodInfo(undefined, "1m").label).toBe("1m");
  });
});
