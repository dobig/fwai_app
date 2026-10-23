import { describe, it, expect } from "vitest";
import {
  fillServerText,
  subscriptionLabel,
  vendorLabel,
} from "@/components/llm-gateway/planCatalog";

// 服务端写好的文案只留占位符给客户端填（日期按本地时区、单位数按输入）。
describe("fillServerText", () => {
  it("填上给了值的占位符，没给的原样留着", () => {
    expect(
      fillServerText("{units} 单位，{when} 生效，{nope} 不动", {
        units: 20,
        when: "2026/8/1",
      }),
    ).toBe("20 单位，2026/8/1 生效，{nope} 不动");
  });

  it("空值不吞掉占位符：宁可露出花括号也不要半句话", () => {
    expect(fillServerText("生效于 {valid_from}", { valid_from: "" })).toBe(
      "生效于 {valid_from}",
    );
  });

  it("服务端没发（老网关）返回空串，调用方据此不渲染", () => {
    expect(fillServerText(undefined)).toBe("");
  });
});

describe("vendorLabel", () => {
  it("目录到手时用服务端的名字，没有时退回兜底表，再不认识就原样", () => {
    const details = [{ id: "claude", label: "克劳德", blurb: "" }];
    expect(vendorLabel("claude", details)).toBe("克劳德");
    expect(vendorLabel("openai", details)).toBe("GPT");
    expect(vendorLabel("gemini")).toBe("gemini");
  });
});

describe("subscriptionLabel", () => {
  it("取标量 tier 对应那张生效套餐的 label，对不上时退回 tier", () => {
    expect(
      subscriptionLabel({
        active: true,
        tier: "pro",
        plans: [
          {
            grant_id: "q",
            tier: "pro",
            label: "排队的那张",
            pending: true,
            usage_micros_per_5h: 0,
            usage_micros_per_week: 0,
            valid_from: "",
            valid_until: "",
          },
          {
            grant_id: "g",
            tier: "pro",
            label: "$100",
            usage_micros_per_5h: 0,
            usage_micros_per_week: 0,
            valid_from: "",
            valid_until: "",
          },
        ],
      }),
    ).toBe("$100");
    expect(subscriptionLabel({ active: true, tier: "pro" })).toBe("pro");
    expect(subscriptionLabel({ active: false })).toBe("会员");
  });
});
