// 对着真实 gateway 跑客户端自己的 API 模块。
//
// tests/api 下的单测全部打在 MSW 上 —— mock 是照契约手写的，所以它们只能证明
// 「客户端和我以为的契约一致」，证明不了「客户端和服务端一致」。两边各自照
// 文档实现、各自测试通过、合起来跑不通，是这类改动最常见的死法。
//
// 这个文件用另一套 vitest 配置（vitest.live.config.ts）跑：不装 MSW，
// VITE_GATEWAY_URL 指向一个真在跑的 gateway。因为要连外部进程，它不在
// `pnpm test:unit` 里，CI 也不跑；改动换档相关代码时手动跑：
//
//   ./scripts/live-gateway-test.sh
//
// 断言只挑「猜错了客户端就会坏」的地方，不重复服务端已经自测过的算术。
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPlanOrder,
  fetchGatewaySubscription,
  fetchPlanQuote,
  fetchGatewayBalance,
  loginGateway,
  planRole,
  setGatewayBaseURL,
  GatewayApiError,
} from "@/lib/api/llm-gateway";

// import.meta.env 是 Vite 构建期注入的，这里跑的是 node，所以显式设一次。
const BASE = process.env.VITE_GATEWAY_URL ?? "http://localhost:8080";

// 服务端的假微信客户端在 goroutine 里结算，所以要轮询而不是 sleep。
async function settle(
  want: string,
  tries = 16,
): Promise<Awaited<ReturnType<typeof fetchGatewaySubscription>>> {
  let last = await fetchGatewaySubscription();
  for (let i = 0; i < tries && last.subscription.tier !== want; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    last = await fetchGatewaySubscription();
  }
  return last;
}

// plans 在类型上是可选的（老服务端不发）。这里对着新服务端跑，缺了就是契约
// 破了，所以断言它在，而不是用 ?. 把问题咽下去。
async function plans() {
  const s = await fetchGatewaySubscription();
  expect(s.subscription.plans).toBeDefined();
  return s.subscription.plans!;
}

describe(`live gateway contract (${BASE})`, () => {
  beforeAll(async () => {
    setGatewayBaseURL(BASE);
    // local 这个种子用户没有订阅，整条序列因此可复现。
    await loginGateway({
      username: "local",
      password: "local123456",
      deviceName: "live-test",
      platform: "local",
    });
  });

  it("反序列化 quote，字段名和类型都对得上", async () => {
    // 没有订阅 → activate_now。这一条同时验证了「没订阅时也能报价」，
    // 客户端进套餐页第一件事就是这个请求。
    const q = await fetchPlanQuote("pro", "1m");
    expect(q.action).toBe("activate_now");
    // 服务端发的是 micro-USD 整数。如果哪天变成字符串或者小数，
    // 客户端所有价格展示会静默错位，所以这里盯类型。
    expect(typeof q.amount_due_micros).toBe("number");
    expect(Number.isInteger(q.amount_due_micros)).toBe(true);
    expect(q.amount_due_micros).toBe(100_000_000);
    expect(typeof q.new_valid_until).toBe("string");
    expect(Number.isNaN(Date.parse(q.new_valid_until))).toBe(false);
  });

  it("加量包超过 99 份被拒，且错误能被客户端识别", async () => {
    // 客户端选择器封在 99；服务端不认这个上限的话，UI 拦不住的输入就会
    // 变成一笔成功的大额订单。
    await expect(
      fetchPlanQuote("extra", "1m", 2000, true),
    ).rejects.toBeInstanceOf(GatewayApiError);
  });

  it("买 12m → 升档零元单 → 找零可再消费，整条链路对得上", async () => {
    // 1) 12m：折扣打在账单上，窗口仍按月。
    const buy = await createPlanOrder("pro", "12m");
    expect(buy.code_url).toBeTruthy();
    expect(buy.amount_due_micros).toBe(1_080_000_000);

    const afterBuy = await settle("pro");
    expect(afterBuy.subscription.active).toBe(true);
    const bought = await plans();
    const grantId = bought[0].grant_id;
    // planRole 是客户端自己的兜底逻辑（老服务端不发 role）。真服务端发了，
    // 这里验的是「发了的时候也判对」。
    expect(planRole(bought[0])).toBe("subscription");

    // 2) 升档到 business：$1077 抵扣盖过 $200 账单 → 零元单。
    const upgrade = await createPlanOrder("business", "1m");
    expect(upgrade.amount_due_micros).toBe(0);
    // 客户端按 key 是否存在分流。空串会把用户送进一个永远扫不出来的二维码页。
    expect("code_url" in upgrade).toBe(false);
    expect(upgrade.code_url).toBeUndefined();
    expect(upgrade.status).toBe("paid");
    // 契约注释里当时写着「服务端建不建 payment_orders 记录还没定」。定了：建。
    // 分流仍然只看 code_url，但 order_id 确实可以拿来做凭据展示。
    expect(upgrade.order_id).toBeTruthy();

    const afterUpgrade = await settle("business");
    // 原地改写：grant_id 不变，否则周窗口和 5h 块被白送一次重置。
    expect((await plans())[0].grant_id).toBe(grantId);
    expect(afterUpgrade.subscription.usage_micros_per_5h).toBe(400_000_000);

    // 3) 找零进余额，且能用于下一笔购买。
    const bal = await fetchGatewayBalance();
    expect(bal.available_credits).toBe(877_000_000);

    const pack = await createPlanOrder("extra", "1m", 20, undefined, true);
    expect(pack.amount_due_micros).toBe(0);
    expect("code_url" in pack).toBe(false);

    // 加量包叠加而不是顶掉订阅层，这是套餐页要分两组渲染的前提。
    const withPack = await plans();
    expect(withPack).toHaveLength(2);
    expect(planRole(withPack[1])).toBe("extra");
    const agg = await fetchGatewaySubscription();
    expect(agg.subscription.usage_micros_per_5h).toBe(420_000_000);
  });

  it("降档排到当前档到期日，且客户端拿的是服务端算的那个日期", async () => {
    const liveEnd = (await plans())[0].valid_until;

    const q = await fetchPlanQuote("starter", "1m");
    expect(q.action).toBe("queue");
    // 客户端要照这个时间写「x 月 x 日起生效」，所以服务端必须发出来 ——
    // 老服务端不发时才退回用当前档到期日推算。
    expect(q.new_valid_from).toBe(liveEnd);

    await createPlanOrder("starter", "1m");
    let queued = await plans();
    for (let i = 0; i < 16 && queued.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      queued = await plans();
    }
    const pending = queued.find((p) => p.pending);
    expect(pending?.tier).toBe("starter");
    expect(pending?.valid_from).toBe(liveEnd);
  });

  it("已经排了一个降档后，再排一个是接在队尾而不是当前档到期日", async () => {
    // 这一条是客户端的一个真 bug 的回归测试：PlanCheckout 原本用「当前生效档
    // 的到期日」当排队文案的日期，而服务端排到的是订阅层里**最远**的到期日。
    // 已经排了一个降档时两者差一整个周期 —— 用户会看到一个比实际早一个月的
    // 切换日期，然后照那个日期来投诉。
    const now = await plans();
    const liveEnd = now.find((p) => !p.pending)?.valid_until;
    const queuedEnd = now.find((p) => p.pending)?.valid_until;
    expect(queuedEnd).toBeDefined();
    expect(queuedEnd).not.toBe(liveEnd);

    const q = await fetchPlanQuote("starter", "1m");
    expect(q.action).toBe("queue");
    expect(q.new_valid_from).toBe(queuedEnd);
    expect(q.new_valid_from).not.toBe(liveEnd);
  });
});
