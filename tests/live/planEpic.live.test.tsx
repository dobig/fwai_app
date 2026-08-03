// 换档 epic 的跨仓联调：真 gateway 的 JSON → 客户端自己的 API 模块 →
// 用户真正看到的那个 React 组件。
//
// 为什么单独一个文件而不是并进 gatewayContract.live.test.ts：那个文件验的是
// 「反序列化对得上」，只用 API 层就够了。这个 epic 的四项改动**全部是显示
// 层的语义**——「同档买第二次说的是续费不是切换」「买来的加量包要显示成
// 倍数、发的专属额度不能显示成倍数」「admin 写的标题要顶替额度描述」。
// 这些断言只在 API 层验字段是验不出来的：字段对了但组件走错分支，用户看到的
// 依然是错的，而这个 epic 报上来的每一个 bug 恰恰都是这一类。
//
// 所以这里一律 render 组件、断言屏幕上的中文。跑法同 tests/live：
//
//   ./scripts/live-gateway-test.sh
//
// 服务端状态在用例之间共享（vitest.live.config.ts 关了并发），顺序即依赖。
import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPlanOrder,
  fetchGatewaySubscription,
  fetchPlanQuote,
  loginGateway,
  redeemPromoCode,
  setGatewayBaseURL,
  GatewayApiError,
  type GatewaySubscriptionStatus,
} from "@/lib/api/llm-gateway";
import { PlanSections } from "@/components/llm-gateway/PlanSections";
import { PlanCheckout } from "@/components/llm-gateway/PlanCheckout";

const BASE = process.env.VITE_GATEWAY_URL ?? "http://localhost:8080";

// 用 user1 而不是 gatewayContract.live 用的 local：那个文件把 local 一路买到
// business + 排了两个降档，状态已经不干净了。user1 的种子是一份生效中的 pro，
// 正好是「同档续费」要复现的前置条件。
const USER = { username: "user1", password: "user123456" };

async function sub(): Promise<GatewaySubscriptionStatus> {
  return (await fetchGatewaySubscription()).subscription;
}

// 假微信在 goroutine 里结算，所以轮询到 predicate 成立而不是 sleep 一个猜的值。
//
// 轮空**抛异常**而不是照常返回最后一次快照：一个永远成立不了的等待条件
// （比如把「兑换前的条数」错读成兑换后的）会让用例静静地慢 6 秒然后变绿，
// 而那 6 秒是它唯一的报警声。宁可炸在这里，也别把一条什么都没验的用例
// 留在套件里冒充覆盖。
async function settleUntil(
  pred: (s: GatewaySubscriptionStatus) => boolean,
  tries = 24,
): Promise<GatewaySubscriptionStatus> {
  let last = await sub();
  for (let i = 0; i < tries && !pred(last); i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    last = await sub();
  }
  if (!pred(last)) {
    throw new Error(
      `等待条件在 ${tries} 次轮询内没有成立，最后一次快照：${JSON.stringify(last.plans)}`,
    );
  }
  return last;
}

// admin 的两条发放路径没有客户端 API 封装（客户端不发码，只兑换），所以这里
// 直接打管理台端点 —— 管理台自己的表单逻辑由 apps/web 的 app.test.mjs 覆盖。
let adminToken = "";
async function adminPost(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

// 每个用例都重新 render 一次：组件读的是快照，服务端状态变了得重新喂进去。
function renderAccountScreen(s: GatewaySubscriptionStatus) {
  const view = render(<PlanSections subscription={s} canBuyExtra />);
  return view;
}

// 「额外额度」那一块。断言必须限定在块内 —— 「加量包」这三个字在按钮和块标题
// 里也出现，全屏搜会搜到不是那一行的东西。
function extrasSection(): HTMLElement {
  const heading = screen.getByText("额外额度");
  const section = heading.closest("section");
  if (!section) throw new Error("额外额度块没渲染出来");
  return section as HTMLElement;
}

describe(`plan epic 联调 (${BASE})`, () => {
  beforeAll(async () => {
    setGatewayBaseURL(BASE);
    const admin = await loginGateway({
      username: "admin",
      password: "admin123456",
      deviceName: "live-test",
      platform: "local",
    });
    adminToken = admin.access_token;
    await loginGateway({
      ...USER,
      deviceName: "live-test",
      platform: "local",
    });
  });

  // --- #196 同档续费 -------------------------------------------------------

  it("同档再买一次报的是 renew，结账页说的是「续费」而不是「到期后切换」", async () => {
    const before = await sub();
    expect(before.tier).toBe("pro");

    const q = await fetchPlanQuote("pro", "3m");
    // 这是用户报的那个 bug 的核心：服务端曾经把同档当降档排队。
    expect(q.action).toBe("renew");
    // 续费没有任何东西被替换，所以一分钱抵扣都不该有。
    expect(q.credit_applied_micros).toBe(0);

    // 客户端这一侧：actionHeadline 的 switch 没有 default，漏 case 是编译错误，
    // 但「编译过了」不等于「文案对」。断言用户读到的那句话。
    render(
      <PlanCheckout
        quote={q}
        currentValidUntil={before.valid_until}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/续费/)).toBeTruthy();
    expect(screen.queryByText(/到期后.*自动切换/)).toBeNull();
  });

  it("付款后是一条 pro 延长 90 天，不是并排两条", async () => {
    const before = await sub();
    const beforePlans = before.plans ?? [];
    const pro = beforePlans.find((p) => p.tier === "pro" && !p.pending);
    expect(pro).toBeDefined();
    const beforeCount = beforePlans.length;
    const beforeEnd = Date.parse(pro!.valid_until);

    await createPlanOrder("pro", "3m");
    const after = await settleUntil(
      (s) =>
        Date.parse(
          (s.plans ?? []).find((p) => p.grant_id === pro!.grant_id)
            ?.valid_until ?? "0",
        ) > beforeEnd,
    );

    const afterPlans = after.plans ?? [];
    // 合并而不是叠加：条数不变。
    expect(afterPlans).toHaveLength(beforeCount);
    const renewed = afterPlans.find((p) => p.grant_id === pro!.grant_id);
    // 同一个 grant —— 换一个就等于白送一次周窗口重置。
    expect(renewed).toBeDefined();
    const days = (Date.parse(renewed!.valid_until) - beforeEnd) / 86_400_000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(92);

    // 账户页上「我的套餐」只有一行 pro，没有「到期后自动切换」的排队行。
    renderAccountScreen(after);
    expect(screen.queryByText(/到期后自动切换/)).toBeNull();
  });

  // --- #197 自选金额档已删 -------------------------------------------------

  it("自助买 custom 被服务端拒绝（不是只在客户端藏入口）", async () => {
    // 客户端已经没有这个入口了，所以绕过 createPlanOrder 直接打端点 ——
    // 要验的正是「有人手搓请求也买不到」。
    const res = await fetch(`${BASE}/v1/plans/custom/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(await loginGateway({ ...USER, deviceName: "live-test", platform: "local" })).access_token}`,
      },
      body: JSON.stringify({ period: "1m", price_usd: 37 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_plan");
  });

  it("目录档下单时 price_usd 被忽略，价格照目录", async () => {
    // 自选档删掉之后，「服务端不接受任意金额」的保证就落在这里：
    // price_usd 仍然是加量包的单位数载体，但对目录档必须无效。
    const q = await fetchPlanQuote("starter", "1m", 3);
    expect(q.target_tier).toBe("starter");
    expect(q.amount_due_micros + q.credit_applied_micros).toBe(20_000_000);
  });

  // --- #199 买来的加量包回读成 extra ---------------------------------------

  it("买来的加量包显示「N× Starter 用量」，admin 发的专属额度不显示倍数", async () => {
    const beforeExtras = ((await sub()).plans ?? []).filter(
      (p) => p.role === "extra",
    ).length;

    // 2 单位加量包。price_usd 在 as_extra 下承载的是单位数 × $20。
    await createPlanOrder("extra", "1m", 40, undefined, true);
    await settleUntil(
      (s) =>
        (s.plans ?? []).filter((p) => p.role === "extra").length >
        beforeExtras,
    );

    // 同一屏上再放一份 admin 直接发的专属额度，两者必须能分辨 ——
    // #199 之前它们在接口里长得一模一样（都是 tier: "custom"）。
    const gift = await adminPost("/admin/subscriptions/activate", {
      username: USER.username,
      tier: "custom",
      usage_micros_per_5h: 37_000_000,
      usage_micros_per_week: 412_000_000,
      validity_days: 30,
      mode: "append",
      reason: "联调用：不成比例的专属额度",
    });
    expect(gift.status).toBeLessThan(300);

    const s = await settleUntil(
      (x) =>
        (x.plans ?? []).filter((p) => p.role === "extra").length >=
        beforeExtras + 2,
    );

    const extras = (s.plans ?? []).filter((p) => p.role === "extra");
    const pack = extras.find((p) => p.tier === "extra");
    const custom = extras.find((p) => p.tier === "custom");
    // 这一条就是 #199：买来的包曾经也回读成 custom，倍数文案永远不出现。
    expect(pack).toBeDefined();
    expect(custom).toBeDefined();

    renderAccountScreen(s);
    const section = extrasSection();
    expect(within(section).getByText("2× Starter 用量")).toBeTruthy();
    expect(within(section).getByText("专属额度")).toBeTruthy();
    // 5h $37 / 周 $412 是不成比例的，硬算倍数会算出 1.9× 这种既难看又不准的
    // 数。断言屏幕上没有任何小数倍数。
    expect(within(section).queryByText(/\d\.\d× Starter/)).toBeNull();
  });

  it("pro 仍是唯一订阅层，专属额度没有挤掉花钱买的套餐", async () => {
    const s = await sub();
    const subs = (s.plans ?? []).filter((p) => p.role !== "extra");
    expect(subs).toHaveLength(1);
    expect(subs[0].tier).toBe("pro");
    // 换档判定也不受影响：当前档仍按 pro 报价。
    const q = await fetchPlanQuote("business", "1m");
    expect(q.current_tier).toBe("pro");
  });

  it("界面上搜不到 5h/周的美元金额，用量仍以倍数表达", async () => {
    const s = await sub();
    const { container } = renderAccountScreen(s);
    const text = container.textContent ?? "";
    // 这是第 3 项的验收标准，也是最容易被一次改动悄悄破坏的东西：
    // 任何人往回加一句 `5h $X` 都会打到这里。
    expect(text).not.toMatch(/5h\s*\$/);
    expect(text).not.toMatch(/每周\s*\$/);
    expect(text).toMatch(/× Starter/);
  });

  // --- #198 title 三级回落 -------------------------------------------------

  it("兑换码带 title 时显示 title，不带时回落到额度描述，note 永不外泄", async () => {
    const NOTE = "故障补偿工单 #443";
    // 兑换**之前**的条数。放在兑换之后读，等待条件就永远成立不了，
    // settleUntil 会空转到 tries 用尽然后照常返回 —— 用例仍然是绿的，
    // 只是慢了 6 秒，而那 6 秒是它唯一的报警声。
    const before = ((await sub()).plans ?? []).length;
    const titled = await adminPost("/admin/promo-codes", {
      username: USER.username,
      tier: "custom",
      usage_micros_per_5h: 25_000_000,
      usage_micros_per_week: 125_000_000,
      validity_days: 30,
      note: NOTE,
      title: "新春回馈",
    });
    expect(titled.status).toBe(201);
    // 管理台自己看得到两列，且各归各位。
    expect(titled.json.title).toBe("新春回馈");
    expect(titled.json.note).toBe(NOTE);

    const untitled = await adminPost("/admin/promo-codes", {
      username: USER.username,
      tier: "custom",
      usage_micros_per_5h: 26_000_000,
      usage_micros_per_week: 130_000_000,
      validity_days: 30,
      note: NOTE,
    });
    expect(untitled.status).toBe(201);
    // 没填 title 就完全没有这个 key（omitempty），不是空串。
    expect("title" in untitled.json).toBe(false);

    await redeemPromoCode(titled.json.code as string);
    await redeemPromoCode(untitled.json.code as string);

    // 等两张码都入账（按条数，不按 title）。用 title 当等待条件的话，一旦
    // 服务端把 title 填错，这里会空转到超时，失败信息就变成「title 是
    // undefined」——指向的是等待条件而不是真正坏掉的东西。
    const s = await settleUntil(
      (x) => (x.plans ?? []).length >= before + 2,
    );

    // 泄漏检查放在最前面：如果 note 顺着某条路径漏成了 title，要让这条用例
    // 以「泄漏」的名义失败，而不是先被别的断言挡下来。
    expect(JSON.stringify(s)).not.toContain("工单");

    const gifted = (s.plans ?? []).find((p) => p.title === "新春回馈");
    expect(gifted?.role).toBe("extra"); // 礼物永远是加量包，不顶掉 pro

    const { container } = renderAccountScreen(s);
    const section = extrasSection();
    // 一级：admin 写的标题顶替额度描述。
    expect(within(section).getByText("新春回馈")).toBeTruthy();
    // 三级：不带 title 的 custom 仍回落到「专属额度」。
    expect(within(section).getAllByText("专属额度").length).toBeGreaterThan(0);
    // 渲染后再验一次：接口不带 ≠ 屏幕上没有（组件可能从别处取到）。
    expect(container.textContent ?? "").not.toContain("工单");
  });

  it("mode=replace 带 title 被拒，而不是静默丢掉", async () => {
    const bad = await adminPost("/admin/subscriptions/activate", {
      username: "user2",
      tier: "starter",
      validity_days: 30,
      mode: "replace",
      // reason 是必填的，且在 title 校验之前就会挡下来。带上它，才验得到
      // 想验的那个 400 —— 否则这条用例会因为另一个原因通过，什么也没证明。
      reason: "联调用",
      title: "x",
    });
    // 静默丢弃的失败模式是 admin 以为用户看到了标题、实际没有，且事后无从发现。
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("title_requires_append");

    // 回归：不带 title 的 replace 仍然照常成功，别把默认路径改坏了。
    const good = await adminPost("/admin/subscriptions/activate", {
      username: "user2",
      tier: "starter",
      validity_days: 30,
      mode: "replace",
      reason: "联调用",
    });
    expect(good.status).toBeLessThan(300);
  });

  it("超长 title 被截断而不是报错", async () => {
    const long = "回".repeat(60);
    const res = await adminPost("/admin/promo-codes", {
      username: USER.username,
      tier: "custom",
      usage_micros_per_5h: 21_000_000,
      usage_micros_per_week: 105_000_000,
      validity_days: 30,
      title: long,
    });
    // admin 粘了一段长文案，正确的处理是让它适配那一行，不是把发码流程打断。
    expect(res.status).toBe(201);
    expect([...(res.json.title as string)]).toHaveLength(40);
  });

  it("加量包 99 份收在服务端，不只是选择器封顶", async () => {
    await expect(
      fetchPlanQuote("extra", "1m", 2000, true),
    ).rejects.toBeInstanceOf(GatewayApiError);
    // 99 是含的 —— 边界写错一格，UI 上能选的最大值会下不了单。
    const ok = await fetchPlanQuote("extra", "1m", 1980, true);
    expect(ok.action).toBe("extra");
  });
});
