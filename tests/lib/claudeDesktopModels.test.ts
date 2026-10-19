import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_MODEL_ROWS,
  isClaudeSafeModelId,
  isPreviousDefaultRoutes,
  metaToRows,
  rowsToMeta,
  validateDesktopForm,
} from "@/lib/claudeDesktopModels";

// 这些用例和后端 claude_desktop_config.rs 的同名测试是一对，两边必须同进同退：
// 前端放过去、后端拦下来只是体验差；反过来（前端放过去、后端也放过去）会让
// Desktop 的模型菜单整个空掉。
describe("isClaudeSafeModelId", () => {
  it("accepts the Claude roles Desktop recognizes", () => {
    for (const id of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5-1",
      "anthropic/claude-sonnet-5",
      "CLAUDE-OPUS-5",
      "  claude-opus-5  ",
    ]) {
      expect(isClaudeSafeModelId(id), id).toBe(true);
    }
  });

  it("rejects names that would trip Desktop's fail-all validator", () => {
    for (const id of [
      // 角色段后没有实际标识
      "claude-sonnet-",
      "claude-opus-",
      "claude-",
      "claude",
      // 非 Claude 系：直连模式不改写模型名，写进去必然被拒
      "gpt-5.6",
      "gpt-6",
      "deepseek-v3",
      // mythos 官方未公开发布
      "claude-mythos-5",
      // [1M] 是 Claude Code 的写法，Desktop schema 不认
      "claude-sonnet-5[1m]",
      "claude-sonnet-5[1M]",
      "",
      "   ",
    ]) {
      expect(isClaudeSafeModelId(id), id).toBe(false);
    }
  });
});

describe("rowsToMeta", () => {
  it("only writes the ticked rows", () => {
    const routes = rowsToMeta([
      {
        role: "Sonnet",
        model: "claude-sonnet-5",
        enabled: true,
        supports1m: true,
      },
      {
        role: "Opus",
        model: "claude-opus-5",
        enabled: false,
        supports1m: true,
      },
    ]);
    expect(Object.keys(routes)).toEqual(["claude-sonnet-5"]);
    expect(routes["claude-sonnet-5"]).toEqual({
      model: "claude-sonnet-5",
      supports1m: true,
    });
  });

  it("maps route to the same upstream name because direct mode cannot rewrite", () => {
    const routes = rowsToMeta([
      {
        role: "Opus",
        model: "claude-opus-5",
        enabled: true,
        supports1m: false,
      },
    ]);
    expect(routes["claude-opus-5"].model).toBe("claude-opus-5");
    // 没勾 1M 就不写这个字段，别在 profile 里留一个 supports1m: false
    expect(routes["claude-opus-5"].supports1m).toBeUndefined();
  });

  it("skips blank model names", () => {
    expect(
      rowsToMeta([
        { role: "Opus", model: "   ", enabled: true, supports1m: false },
      ]),
    ).toEqual({});
  });
});

describe("metaToRows", () => {
  it("falls back to the defaults when nothing is stored", () => {
    expect(metaToRows(undefined)).toEqual(DEFAULT_DESKTOP_MODEL_ROWS);
    expect(metaToRows({ claudeDesktopModelRoutes: {} })).toEqual(
      DEFAULT_DESKTOP_MODEL_ROWS,
    );
  });

  it("ticks exactly the stored models", () => {
    const rows = metaToRows({
      claudeDesktopModelRoutes: {
        "claude-opus-5-5": { model: "claude-opus-5-5", supports1m: true },
      },
    });
    const opus = rows.find((row) => row.model === "claude-opus-5-5");
    expect(opus?.enabled).toBe(true);
    expect(opus?.supports1m).toBe(true);
    expect(rows.find((row) => row.model === "claude-sonnet-5-5")?.enabled).toBe(
      false,
    );
  });

  it("keeps a hand-typed model that is not one of the four defaults", () => {
    // 不保留的话，编辑一次就把用户自己填的模型悄悄丢掉了
    const rows = metaToRows({
      claudeDesktopModelRoutes: {
        "claude-opus-4-8": { model: "claude-opus-4-8" },
      },
    });
    const custom = rows.find((row) => row.model === "claude-opus-4-8");
    expect(custom).toBeDefined();
    expect(custom?.enabled).toBe(true);
  });

  it("round-trips through rowsToMeta", () => {
    const routes = {
      "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: true },
      "claude-haiku-4-5-20251001": { model: "claude-haiku-4-5-20251001" },
    };
    expect(
      rowsToMeta(metaToRows({ claudeDesktopModelRoutes: routes })),
    ).toEqual(routes);
  });
});

describe("validateDesktopForm", () => {
  const rows = [
    {
      role: "Sonnet",
      model: "claude-sonnet-5",
      enabled: true,
      supports1m: false,
    },
  ];

  it("passes a well-formed config", () => {
    expect(
      validateDesktopForm({
        baseUrl: "https://api.fwai.space",
        apiKey: "sk-x",
        rows,
      }),
    ).toBeNull();
  });

  it("requires both credentials", () => {
    expect(
      validateDesktopForm({ baseUrl: "", apiKey: "sk-x", rows }),
    ).toContain("端点");
    expect(
      validateDesktopForm({ baseUrl: "https://x", apiKey: "  ", rows }),
    ).toContain("API Key");
  });

  it("blocks a model name Desktop would reject", () => {
    const message = validateDesktopForm({
      baseUrl: "https://x",
      apiKey: "sk-x",
      rows: [
        { role: "自定义", model: "gpt-5.6", enabled: true, supports1m: false },
      ],
    });
    expect(message).toContain("gpt-5.6");
  });

  it("ignores unticked rows even if their names are invalid", () => {
    expect(
      validateDesktopForm({
        baseUrl: "https://x",
        apiKey: "sk-x",
        rows: [
          {
            role: "自定义",
            model: "gpt-5.6",
            enabled: false,
            supports1m: false,
          },
        ],
      }),
    ).toBeNull();
  });

  it("allows an empty selection so Desktop reads /v1/models itself", () => {
    expect(
      validateDesktopForm({
        baseUrl: "https://x",
        apiKey: "sk-x",
        rows: DEFAULT_DESKTOP_MODEL_ROWS.map((row) => ({
          ...row,
          enabled: false,
        })),
      }),
    ).toBeNull();
  });
});

describe("isPreviousDefaultRoutes", () => {
  const routes = (...models: string[]) =>
    Object.fromEntries(models.map((model) => [model, { model }]));

  it("recognizes an untouched previous default set, in any order", () => {
    expect(
      isPreviousDefaultRoutes(
        routes("claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"),
      ),
    ).toBe(true);
  });

  it("leaves edited or current lists alone", () => {
    // 当前默认
    expect(
      isPreviousDefaultRoutes(rowsToMeta(DEFAULT_DESKTOP_MODEL_ROWS)),
    ).toBe(false);
    // 用户勾上了 Fable
    expect(
      isPreviousDefaultRoutes(
        routes(
          "claude-sonnet-5",
          "claude-opus-5",
          "claude-haiku-4-5-20251001",
          "claude-fable-5-1",
        ),
      ),
    ).toBe(false);
    // 用户去掉了一档
    expect(
      isPreviousDefaultRoutes(routes("claude-sonnet-5", "claude-opus-5")),
    ).toBe(false);
    expect(isPreviousDefaultRoutes(undefined)).toBe(false);
  });
});
