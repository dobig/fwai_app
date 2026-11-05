import { describe, it, expect } from "vitest";
import {
  fiveHourGrantFooter,
  fiveHourGrantLabel,
  foldedSummary,
  formatWeekReset,
  hasGrantFiveHour,
  plansInVendorGroup,
  splitWeekGrants,
  weekGrantFooter,
  weekGrantLabel,
  type WeekGrant,
} from "@/components/llm-gateway/grantWeeks";
import type { GatewaySubscriptionPlan } from "@/lib/api/llm-gateway";

// 每份额度各自按 7 天一轮刷新（#79）。这里断言的是「哪几条常显、哪几条收起、
// 顺序、文案」，和 React 无关。

function plan(
  patch: Partial<GatewaySubscriptionPlan> & { grant_id: string },
): GatewaySubscriptionPlan {
  return {
    tier: "pro",
    usage_micros_per_5h: 0,
    usage_micros_per_week: 0,
    valid_from: "2026-10-01T00:00:00Z",
    valid_until: "2026-11-20T09:00:00Z",
    ...patch,
  };
}

const SUB = plan({
  grant_id: "grant_a1",
  role: "subscription",
  kind: "subscription",
  week_resets_at: "2026-10-28T09:00:00Z",
  week_utilization: 25,
});
const PACK_LATE = plan({
  grant_id: "grant_b2",
  role: "extra",
  kind: "pack",
  week_resets_at: "2026-10-30T14:00:00Z",
  week_utilization: 0,
});
const PACK_EXPIRING = plan({
  grant_id: "grant_c3",
  role: "extra",
  kind: "pack",
  valid_until: "2026-10-25T08:00:00Z",
  week_utilization: 100,
});
const GIFT = plan({
  grant_id: "grant_d4",
  role: "extra",
  kind: "gift",
  title: "新春回馈",
  week_resets_at: "2026-10-31T10:00:00Z",
  week_utilization: 0,
});

const ids = (grants: WeekGrant[]) => grants.map((p) => p.grant_id);

describe("splitWeekGrants", () => {
  it("订阅常显，加量 / 赠送收起；同一类保持服务端顺序", () => {
    // 服务端给的顺序里加量包和赠送交错：客户端按类分组，组内不重排。
    const split = splitWeekGrants([SUB, PACK_EXPIRING, GIFT, PACK_LATE]);
    expect(ids(split!.pinned)).toEqual(["grant_a1"]);
    expect(ids(split!.folded)).toEqual(["grant_c3", "grant_b2", "grant_d4"]);
  });

  it("订阅已过期、只剩加量 / 赠送时直接显示，不收起", () => {
    const split = splitWeekGrants([GIFT, PACK_LATE]);
    expect(ids(split!.pinned)).toEqual(["grant_b2", "grant_d4"]);
    expect(split!.folded).toEqual([]);
  });

  it("排队中的、纯视频的、组织的都不进来", () => {
    const split = splitWeekGrants([
      SUB,
      plan({ grant_id: "q", kind: "pack", pending: true }),
      plan({ grant_id: "v", kind: "video" }),
      plan({ grant_id: "e", kind: "enterprise", week_utilization: 3 }),
    ]);
    expect(ids(split!.pinned)).toEqual(["grant_a1"]);
    expect(split!.folded).toEqual([]);
  });

  it("老服务端（没有 kind / week_*）返回 null，调用方退回单条 7 天", () => {
    const legacy = [SUB, PACK_LATE].map(
      ({ kind: _k, week_resets_at: _r, week_utilization: _u, ...p }) => p,
    );
    expect(splitWeekGrants(legacy)).toBeNull();
    expect(splitWeekGrants(undefined)).toBeNull();
    expect(splitWeekGrants([])).toBeNull();
  });

  it("只有排队中的也返回 null", () => {
    expect(
      splitWeekGrants([
        plan({ grant_id: "q", kind: "subscription", pending: true }),
      ]),
    ).toBeNull();
  });
});

describe("kind: extra", () => {
  it("服务端认不出来源时填的 extra 按赠送算", () => {
    const split = splitWeekGrants([
      SUB,
      plan({
        grant_id: "x",
        role: "extra",
        kind: "extra",
        week_utilization: 9,
      }),
    ]);
    expect(split!.folded.map((p) => [p.grant_id, p.kind])).toEqual([
      ["x", "gift"],
    ]);
  });
});

describe("plansInVendorGroup", () => {
  const claude = plan({ grant_id: "c", vendor: "claude" });
  const gpt = plan({ grant_id: "g", vendor: "openai" });
  const unbound = plan({ grant_id: "u" });
  const all = [claude, gpt, unbound];
  const gid = (ps: GatewaySubscriptionPlan[]) => ps.map((p) => p.grant_id);

  it("按 vendor 进组，没绑定的进「通用」", () => {
    const groups = ["claude", "openai", null];
    expect(gid(plansInVendorGroup(all, "claude", groups))).toEqual(["c"]);
    expect(gid(plansInVendorGroup(all, "openai", groups))).toEqual(["g"]);
    expect(gid(plansInVendorGroup(all, null, groups))).toEqual(["u"]);
  });

  it("没有分组（老服务端）时全在一组", () => {
    expect(gid(plansInVendorGroup(all, undefined, []))).toEqual([
      "c",
      "g",
      "u",
    ]);
  });

  it("找不到自己的组时进「通用」，没有「通用」就进第一组，不丢", () => {
    expect(gid(plansInVendorGroup(all, null, ["claude", null]))).toEqual([
      "g",
      "u",
    ]);
    expect(gid(plansInVendorGroup(all, "claude", ["claude"]))).toEqual([
      "c",
      "g",
      "u",
    ]);
  });
});

describe("weekGrantLabel", () => {
  const [sub] = splitWeekGrants([SUB])!.pinned;
  const [gift] = splitWeekGrants([GIFT])!.pinned;

  it("按类写短名", () => {
    expect(weekGrantLabel(sub, false)).toBe("7 天 · 订阅");
    expect(weekGrantLabel(gift, false)).toBe("7 天 · 赠送");
  });

  it("有厂商时写上厂商，没绑定的是「通用」", () => {
    expect(
      weekGrantLabel(
        { ...sub, vendor: "claude", vendor_label: "Claude" },
        true,
      ),
    ).toBe("7 天 · Claude 订阅");
    expect(weekGrantLabel(gift, true)).toBe("7 天 · 通用 赠送");
  });
});

describe("foldedSummary", () => {
  it("同类多份写 ×n，没有的类不写", () => {
    const { folded } = splitWeekGrants([SUB, PACK_EXPIRING, PACK_LATE, GIFT])!;
    expect(foldedSummary(folded)).toEqual(["加量 ×2", "赠送"]);
    expect(foldedSummary(folded.slice(0, 1))).toEqual(["加量"]);
  });
});

describe("weekGrantFooter", () => {
  const split = splitWeekGrants([SUB, PACK_EXPIRING, PACK_LATE])!;
  const [sub] = split.pinned;
  const [expiring, late] = split.folded;

  it("正常写刷新时间（本地时区）", () => {
    expect(weekGrantFooter(sub)).toEqual({
      text: `${formatWeekReset("2026-10-28T09:00:00Z")} 刷新`,
      tone: "muted",
    });
  });

  it("下次刷新前就到期：写到期日，不写刷新时间", () => {
    const footer = weekGrantFooter(expiring);
    expect(footer.tone).toBe("warn");
    expect(footer.text).toMatch(/^\d{1,2}\/\d{1,2} 到期 · 不再刷新$/);
  });

  it("用满了写什么时候恢复", () => {
    expect(weekGrantFooter({ ...late, week_utilization: 100 })).toEqual({
      text: `已用完 · ${formatWeekReset("2026-10-30T14:00:00Z")} 恢复`,
      tone: "danger",
    });
  });
});

describe("每份的 5 小时（llm_gateway#583）", () => {
  const withFiveHour = (
    p: GatewaySubscriptionPlan,
    utilization: number,
    resets?: string,
  ) => ({
    ...p,
    five_hour_utilization: utilization,
    five_hour_resets_at: resets,
  });

  it("只要有一份带了 5 小时就算服务端按份给了；都不带是老服务端", () => {
    expect(hasGrantFiveHour(splitWeekGrants([SUB, PACK_LATE]))).toBe(false);
    expect(
      hasGrantFiveHour(splitWeekGrants([SUB, withFiveHour(PACK_LATE, 0)])),
    ).toBe(true);
    expect(hasGrantFiveHour(null)).toBe(false);
  });

  it("标题和时间行", () => {
    const [sub] = splitWeekGrants([
      withFiveHour(SUB, 40, "2026-10-21T05:00:00Z"),
    ])!.pinned;
    expect(fiveHourGrantLabel(sub, false)).toBe("5 小时 · 订阅");
    expect(fiveHourGrantFooter(sub)).toEqual({
      text: `${formatWeekReset("2026-10-21T05:00:00Z")} 重置`,
      tone: "muted",
    });

    const [full] = splitWeekGrants([
      withFiveHour(SUB, 100, "2026-10-21T05:00:00Z"),
    ])!.pinned;
    expect(fiveHourGrantFooter(full)?.tone).toBe("danger");

    // 窗口还没扣过钱：没有时间行。
    const [idle] = splitWeekGrants([withFiveHour(SUB, 0)])!.pinned;
    expect(fiveHourGrantFooter(idle)).toBeNull();
  });
});
