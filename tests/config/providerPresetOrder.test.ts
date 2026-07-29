import { describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";

const namesOf = (presets: Array<{ name: string }>) =>
  presets.map((preset) => preset.name);

const expectInOrder = (names: string[], expected: string[]) => {
  const indexes = expected.map((name) => names.indexOf(name));

  expect(indexes).not.toContain(-1);
  expect(indexes).toEqual(expected.map((_, index) => indexes[0] + index));
};

describe("provider preset order", () => {
  it("Claude 预设按合作伙伴优先顺序排列", () => {
    expectInOrder(namesOf(providerPresets), [
      "Shengsuanyun",
      "PatewayAI",
      "火山Agentplan",
      "BytePlus",
      "DouBaoSeed",
    ]);
  });

  it("Codex 预设把 PatewayAI 放在胜算云后面", () => {
    expectInOrder(namesOf(codexProviderPresets), ["Shengsuanyun", "PatewayAI"]);
  });

});
