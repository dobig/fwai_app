import {
  CLIENT_UPGRADE_HEADER,
  CLIENT_VERSION_HEADER,
  CLIENT_VERSION_VALUE,
  recordUpgradeSignal,
} from "@/lib/clientUpgrade";
import {
  CLIENT_UPGRADE_REQUIRED_CODE,
  recordUpgradeRefusal,
} from "@/lib/forceUpgrade";

export interface GatewayTokens {
  token_type: "Bearer";
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  installation_id?: string;
}

export interface GatewayUserProfile {
  id: string;
  username: string;
  email: string;
  role: "user" | "admin";
  // False until the address is proven reachable via a mailed code. Unverified
  // users can sign in and browse; the gateway only stops them at purchase.
  email_verified: boolean;
  // 发给上游前是否把提示里的密钥/凭据替换成占位符（服务端 #255）。老服务端
  // 不返回这个字段，所以是可选：读的时候 undefined 当作「未开启」。
  redact_secrets?: boolean;
  // 发给上游前是否压缩工具输出（服务端 #260）。同样可选，undefined 当作「未开启」。
  tool_compression?: boolean;
}

export interface GatewayAccountProfile {
  id: string;
}

// 套餐和加量包按上游厂商分开卖：Claude 和 GPT 是两份独立的订阅，各自换档、
// 续费、排队，一份额度只付它那一家模型的钱（llm_gateway#445/#446）。值和服务端
// 的 chargerate 家族一致 —— GPT 那一家在线上叫 openai。
export type GatewayVendor = "claude" | "openai";

// 一个 grant 的角色。subscription 是订阅层（同时只有一张生效，可换档），
// extra 是临时加量包（叠加，自然到期，不参与换档判定）。
export type GatewayPlanRole = "subscription" | "extra";

// 一个独立计量的套餐。套餐可叠加，用户同时可以持有多个。
// pending 为 true 表示这个套餐还没开始生效（排队中）。
export interface GatewaySubscriptionPlan {
  grant_id: string;
  tier: string;
  // admin 发放/兑换码签发时填的用户可见标题（如「新春回馈」）。自助购买的
  // grant 永远没有，老服务端也不返回 —— 服务端用 omitempty，所以这里是可选。
  // 只有额外额度（role=extra）会有：订阅层那一行没有放标题的位置。
  // 服务端算 description 时已经把它考虑进去了，客户端不再自己读。
  title?: string;
  usage_micros_per_5h: number;
  usage_micros_per_week: number;
  valid_from: string;
  valid_until: string;
  pending?: boolean;
  // 老服务端不返回这个字段 —— 和 plans 本身可选是同一个先例。
  // 读取一律走 planRole()，别直接读这里。
  role?: GatewayPlanRole;
  // 这份额度绑定的厂商。缺省（omitempty）是绑定之前买的，两家的模型都能用；
  // 老服务端也不返回。
  vendor?: string;
  // 以下是服务端写好的展示文案（见网关 CONTRACT「Display copy」）。规则一变
  // 文案就跟着变，所以不在客户端拼：
  //   label         档位名（「$200」「加量包」「专属额度」）
  //   vendor_label  厂商标签（「Claude」「GPT」，没绑定的是「通用」）
  //   description   额度描述，按这张 grant **自己的**额度算（「20× Starter 用量」）
  //   pending_text  排队中的订阅层那一整句，日期是 {valid_from} 占位符
  label?: string;
  vendor_label?: string;
  description?: string;
  pending_text?: string;
}

// 缺失的 role 按 subscription 处理：老服务端下所有套餐都落在「我的套餐」块里，
// 退化成加换档之前的行为。写成函数而不是散落各处的 `?? "subscription"`，
// 是因为这个默认值一旦有一处写反，加量包就会被当成订阅层显示。
export function planRole(plan: GatewaySubscriptionPlan): GatewayPlanRole {
  return plan.role === "extra" ? "extra" : "subscription";
}

export interface GatewaySubscriptionStatus {
  active: boolean;
  // 以下标量字段是叠加之前的形状，服务端仍在返回：tier 是最贵的那个生效
  // 套餐，两个上限是各生效套餐之和，valid_until 是最晚的到期时间。
  // 展示明细请用 plans —— 标量字段表达不出「哪一层先被扣」。
  tier?: string;
  usage_micros_per_5h?: number;
  usage_micros_per_week?: number;
  valid_until?: string;
  // 老版本服务端不返回这个字段，所以可能是 undefined。
  plans?: GatewaySubscriptionPlan[];
  // 生效档位的名字（「$200」），账号卡片右上角用。
  label?: string;
  // 「总用量 15× Starter（含额外额度）」，服务端写好的整句。
  usage_text?: string;
}

export interface GatewayLoginResult extends GatewayTokens {
  user: GatewayUserProfile;
  account: GatewayAccountProfile;
  subscription: GatewaySubscriptionStatus;
}

// DEFAULT_GATEWAY_URL is baked at build time from VITE_GATEWAY_URL (set in the
// release workflow) so shipped binaries point at prod; local dev falls back to
// localhost. Trailing slashes are stripped here — and again in
// getGatewayBaseURL — so a base like "https://api.fwai.space/" never turns
// requests into "https://api.fwai.space//v1/...".
const DEFAULT_GATEWAY_URL = (
  import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8080"
).replace(/\/+$/, "");
const TOKEN_STORAGE_KEY = "llm-gateway-oauth";
const BASE_URL_STORAGE_KEY = "llm-gateway-base-url";
const LOGIN_STORAGE_KEY = "llm-gateway-login";

export function getGatewayBaseURL(): string {
  const raw = localStorage.getItem(BASE_URL_STORAGE_KEY) || DEFAULT_GATEWAY_URL;
  // Normalize on read too: a stored value from before setGatewayBaseURL stripped
  // slashes (or a hand-set localStorage entry) must not produce "//v1/..." paths
  // that a fronting proxy can 404 before the request reaches the gateway.
  return raw.replace(/\/+$/, "");
}

export function setGatewayBaseURL(baseURL: string): void {
  localStorage.setItem(BASE_URL_STORAGE_KEY, baseURL.replace(/\/+$/, ""));
}

export function saveGatewayTokens(tokens: GatewayTokens): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

// 登录信息变了（登录、登出、资料更新）时在 window 上广播，让不在同一棵组件树里
// 的读者（应用设置页里的账号开关、右下角的网关面板）跟着刷新。localStorage 的
// "storage" 事件只在别的窗口触发，同一窗口里必须自己发。
export const GATEWAY_LOGIN_CHANGED_EVENT = "llm-gateway-login-changed";

function announceGatewayLoginChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(GATEWAY_LOGIN_CHANGED_EVENT));
  }
}

export function saveGatewayLogin(login: GatewayLoginResult): void {
  saveGatewayTokens(login);
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(login));
  announceGatewayLoginChanged();
}

export function clearGatewayLogin(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(LOGIN_STORAGE_KEY);
  announceGatewayLoginChanged();
}

// updateGatewayUserProfile 把服务端返回的最新资料合并进缓存的登录信息并广播。
// 没登录时什么也不做。
export function updateGatewayUserProfile(user: GatewayUserProfile): void {
  const login = loadGatewayLogin();
  if (!login) return;
  saveGatewayLogin({ ...login, user: { ...login.user, ...user } });
}

export function loadGatewayTokens(): GatewayTokens | null {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GatewayTokens;
  } catch {
    return null;
  }
}

export function loadGatewayLogin(): GatewayLoginResult | null {
  const raw = localStorage.getItem(LOGIN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GatewayLoginResult;
  } catch {
    return null;
  }
}

// GatewayApiError carries the pieces callers actually branch on — the HTTP
// status and the gateway's error code (e.g. "email_not_verified") — so they can
// test `error.code === "..."` instead of pattern-matching the message. Matching
// text is how `/401/` came to also fire on any message that merely contained
// "401" somewhere. Mirrors GatewayError in the admin console (apps/web/src/api.js).
//
// The message keeps its exact previous format: call sites that still read
// `error.message` (and the toasts users see) are unaffected.
export class GatewayApiError extends Error {
  readonly status: number;
  readonly code: string;
  // The parsed error body, when there was one. Most failures say everything in
  // `code`, but some carry payload the caller needs: a 409 from login brings the
  // challenge that the second leg is built from. Empty object for a non-JSON
  // body, so call sites can read a field without a null check first.
  readonly body: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    body: Record<string, unknown> = {},
  ) {
    super(
      code
        ? `llm_gateway request failed: ${status} (${code})`
        : `llm_gateway request failed: ${status}`,
    );
    this.name = "GatewayApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function gatewayRequest<T>(
  path: string,
  init: RequestInit = {},
  authenticated = false,
): Promise<T> {
  const token = loadGatewayTokens()?.access_token;
  const response = await fetch(`${getGatewayBaseURL()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // 在这一层统一注入，所有调用点自动带上。逐个改调用点的话，下一个新增
      // 的端点一定会漏掉。
      [CLIENT_VERSION_HEADER]: CLIENT_VERSION_VALUE,
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  // 失败响应上也读：401/403 一样可能带升级提示，而且「版本太老」正是服务端
  // 打回请求的原因之一。
  recordUpgradeSignal(response.headers.get(CLIENT_UPGRADE_HEADER));
  if (!response.ok) {
    // Surface the gateway's error code (e.g. {"error":"create_payment_failed"})
    // instead of swallowing it behind a bare status — callers branch on it and
    // show it in a toast.
    let detail = "";
    let body: Record<string, unknown> = {};
    try {
      const parsed = (await response.clone().json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
        const val = body.error ?? body.message;
        if (val != null) detail = String(val);
      }
    } catch {
      // Non-JSON error body; fall back to the status code alone.
    }
    // 网关说这个版本已经停止服务了：锁住整个 App（见 ForceUpgradeGate）。
    if (response.status === 426 && detail === CLIENT_UPGRADE_REQUIRED_CODE) {
      recordUpgradeRefusal(body.min_version);
    }
    throw new GatewayApiError(response.status, detail, body);
  }
  // 204 and other empty successes have no body to parse; password reset answers
  // 204, and an unconditional json() would turn a success into a thrown error.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// A login that needs a second factor: the password was CORRECT, and the gateway
// mailed a code to the address on the account. Whether this happens is entirely
// the server's call (it depends on server config and our reported version), so
// there is nothing to predict client-side — the 409 is the only signal.
export interface GatewayLoginChallenge {
  kind: "challenge";
  challengeId: string;
  // The destination, masked by the server (e.g. "t*****@example.com"), so a user
  // with several addresses knows which inbox to open.
  emailHint: string;
  // The code's lifetime in seconds, for a countdown.
  expiresIn: number;
  // False when the server's resend cooldown suppressed a NEW mail. The previous
  // code is still live, so this is informational — never an error.
  sent: boolean;
}

// Either a finished login or a challenge to complete. Callers must branch on
// `kind`: treating a challenge as a failure is the mistake this type exists to
// make impossible.
export type GatewayLoginOutcome =
  | ({ kind: "session" } & GatewayLoginResult)
  | GatewayLoginChallenge;

// The gateway's 409 body for a login awaiting its mailed code.
interface LoginChallengeBody {
  challenge_id?: unknown;
  email_hint?: unknown;
  expires_in?: unknown;
  sent?: unknown;
}

export async function loginGateway(input: {
  username: string;
  password: string;
  deviceName: string;
  platform: string;
}): Promise<GatewayLoginOutcome> {
  try {
    const login = await gatewayRequest<GatewayLoginResult>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        device_name: input.deviceName,
        platform: input.platform,
        app_version: "cc-switch-custom/llm-gateway-local",
      }),
    });
    saveGatewayLogin(login);
    return { kind: "session", ...login };
  } catch (error) {
    // 409 + email_code_required is a correct password awaiting its code, not a
    // failed login. Both conditions are required: a future 409 for some other
    // reason must keep falling through to the caller's error path rather than
    // stranding the user on a code prompt no code will ever satisfy.
    if (
      error instanceof GatewayApiError &&
      error.status === 409 &&
      error.code === "email_code_required"
    ) {
      const body = error.body as LoginChallengeBody;
      const challengeId = String(body.challenge_id ?? "");
      // A 409 we cannot act on is worse than an error: the code prompt would
      // have nothing to submit against. Rethrow so the caller shows a failure.
      if (challengeId) {
        return {
          kind: "challenge",
          challengeId,
          emailHint: String(body.email_hint ?? ""),
          expiresIn:
            typeof body.expires_in === "number" ? body.expires_in : 600,
          sent: body.sent !== false,
        };
      }
    }
    throw error;
  }
}

// verifyGatewayLogin completes a two-step login. Public — the session is what it
// is asking for — and authenticated instead by the code mailed to the account's
// own address.
//
// It deliberately sends ONLY the challenge id and the code. The device was
// captured server-side when the password was checked; if this call could name
// its own device, a code lifted from the victim's inbox would mint a session for
// the attacker's machine. Adding device fields here would silently undo that.
//
// Returns the same shape a single-step login does, so the caller's post-login
// path is identical.
export async function verifyGatewayLogin(input: {
  challengeId: string;
  code: string;
}): Promise<GatewayLoginResult> {
  const login = await gatewayRequest<GatewayLoginResult>(
    "/v1/auth/login/verify",
    {
      method: "POST",
      body: JSON.stringify({
        challenge_id: input.challengeId,
        code: input.code.trim(),
      }),
    },
  );
  saveGatewayLogin(login);
  return login;
}

// refreshGatewayToken exchanges the stored refresh token for a fresh access
// token (POST /oauth/token, grant_type=refresh_token) and persists the result.
// Throws if there is no refresh token or the gateway rejects it.
export async function refreshGatewayToken(): Promise<GatewayTokens> {
  const current = loadGatewayTokens();
  if (!current?.refresh_token) {
    throw new Error("no refresh token available");
  }
  const tokens = await gatewayRequest<GatewayTokens>("/oauth/token", {
    method: "POST",
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    }),
  });
  // Keep the previous refresh token if the server rotates lazily (omits it).
  const merged: GatewayTokens = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? current.refresh_token,
  };
  saveGatewayTokens(merged);
  const login = loadGatewayLogin();
  if (login) {
    saveGatewayLogin({ ...login, ...merged });
  }
  return merged;
}

// revokeGatewayToken invalidates a refresh token server-side (POST
// /oauth/revoke). All access tokens bound to it die with it.
//
// Logout passes the token explicitly because it has already cleared local
// storage by the time this runs, and bounds the call with a timeout: a fetch
// with no deadline never settles on a dead network.
export async function revokeGatewayToken(
  options: { refreshToken?: string; timeoutMs?: number } = {},
): Promise<void> {
  const refreshToken =
    options.refreshToken ?? loadGatewayTokens()?.refresh_token;
  if (!refreshToken) return;
  const controller = new AbortController();
  const timer =
    options.timeoutMs != null
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
  try {
    // Direct fetch: the endpoint answers 204 No Content, which gatewayRequest's
    // unconditional response.json() would choke on.
    const response = await fetch(`${getGatewayBaseURL()}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`llm_gateway revoke failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function registerGateway(input: {
  username: string;
  password: string;
  email: string;
  deviceName: string;
  platform: string;
  inviteCode?: string;
}): Promise<GatewayLoginResult> {
  const inviteCode = input.inviteCode?.trim();
  const login = await gatewayRequest<GatewayLoginResult>("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: input.username,
      password: input.password,
      email: input.email,
      device_name: input.deviceName,
      platform: input.platform,
      app_version: "cc-switch-custom/llm-gateway-local",
      ...(inviteCode ? { invite_code: inviteCode } : {}),
    }),
  });
  saveGatewayLogin(login);
  return login;
}

export async function registerGatewayInstallation(input: {
  userId: string;
  accountId: string;
  deviceName: string;
  platform: string;
}): Promise<GatewayTokens> {
  const tokens = await gatewayRequest<GatewayTokens>("/v1/installations", {
    method: "POST",
    body: JSON.stringify({
      user_id: input.userId,
      account_id: input.accountId,
      device_name: input.deviceName,
      platform: input.platform,
      app_version: "cc-switch-custom/llm-gateway-local",
    }),
  });
  saveGatewayTokens(tokens);
  return tokens;
}

export function gatewayEndpointURL(): string {
  return `${getGatewayBaseURL()}/v1/chat/completions`;
}

export function gatewayOAuthAccessToken(): string {
  return loadGatewayTokens()?.access_token || "";
}

export interface GatewayBalance {
  account_id: string;
  available_credits: number;
  pending_credits: number;
  updated_at?: string;
}

export async function fetchGatewayBalance(): Promise<GatewayBalance> {
  return await gatewayRequest<GatewayBalance>(
    "/v1/account/balance",
    { method: "GET" },
    true,
  );
}

export interface GatewayRechargeResult {
  payment_order_id: string;
  code_url: string;
  amount_credits: number;
  balance: GatewayBalance;
}

export async function rechargeGateway(
  amountCredits: number,
): Promise<GatewayRechargeResult> {
  return await gatewayRequest<GatewayRechargeResult>(
    "/v1/dev/recharge",
    {
      method: "POST",
      body: JSON.stringify({
        amount_credits: Math.max(1, Math.floor(amountCredits)),
      }),
    },
    true,
  );
}

// --- WeChat Pay Native orders (scan-to-pay) ---------------------------------

export interface GatewayNativeOrder {
  order_id: string;
  account_id: string;
  amount_credits: number;
  amount_cents: number;
  exchange_rate: number;
  currency: string;
  status: string;
  code_url: string;
}

export interface GatewayPaymentOrder {
  order_id: string;
  status: string;
  amount_credits: number;
  amount_cents: number;
  currency: string;
  paid_at?: string;
}

// getPaymentOrder polls a recharge order's status while the client waits for the
// WeChat callback to credit the account.
export async function getPaymentOrder(
  orderId: string,
): Promise<GatewayPaymentOrder> {
  return await gatewayRequest<GatewayPaymentOrder>(
    `/v1/payments/orders/${encodeURIComponent(orderId)}`,
    { method: "GET" },
    true,
  );
}

// --- 套餐换档 ---------------------------------------------------------------

// GET /v1/plans 里某个周期的价格。**全部是服务端算好的成品价**，客户端只
// 负责显示，不做任何加减乘除 —— 本地留一份折扣表去乘的话，服务端一调价
// 两边就对不上（6 个月到底是 9 折还是 95 折这种问题就是这么来的）。
//   charge_micros    整个周期要付多少（已打折）
//   list_micros      同一周期不打折的原价
//   savings_micros   省了多少，0 表示这一档没有折扣
//   per_unit_micros  折到每月 / 每周（per_unit）是多少
export interface GatewayPeriodPrice {
  period: string;
  charge_micros: number;
  list_micros: number;
  savings_micros: number;
  per_unit_micros: number;
  per_unit: "month" | "week";
}

export interface GatewayCatalogPlan {
  id: string;
  // 档位名，就是月价（「$200」）。
  name: string;
  price_usd_micros: number;
  // 这一档卖的周期，按服务端顺序。不含只卖给加量包的周付档。
  prices: GatewayPeriodPrice[];
  // 服务端写好的展示文案：档位卡片下那行小字（「5× Starter 用量」）、选周期
  // 那一屏的说明（「Starter · 适合大部分普通用户」）、卡片角标（「最受欢迎」，
  // 没有就是空串）。
  blurb?: string;
  description?: string;
  badge?: string;
}

export interface GatewayCatalogPeriod {
  key: string;
  // 「1 周」「1 个月」。
  label?: string;
  days: number;
  // 只用来画「9折」角标，不拿来算价。
  discount_bps: number;
  extra_only: boolean;
  // 能买这个周期的厂商，套餐和加量包都算。Claude 最长一个月，GPT 不限。
  // 老服务端不发 —— 那边所有周期对所有厂商开放。读的时候走 periodOpenTo()。
  vendors?: string[];
}

// 这个用户此刻能不能买加量包。**只是提示**：报价和下单两个端点会重新校验一切，
// 所以界面上过期的「能买」最坏只会换来一个 409，反过来不会发生。
//
// reason 就是此刻下单会拿到的错误码：subscription_required（没有生效的套餐，
// 赠送额度不算）或 extra_pack_limit（加量包已到同时持有上限）。
export interface GatewayExtraEligibility {
  plan_in_force: boolean;
  active_paid_packs: number;
  can_buy: boolean;
  reason?: "subscription_required" | "extra_pack_limit" | string;
}

// 目录里的加量包 SKU。prices 之后的字段老网关不发，所以全部可选；缺省时客户端
// 退回老规则（1–max_units 任选、无前置条件）。
// prices 是**一个单位**的各周期价格，N 单位的实付以结账页的 quote 为准。
export interface GatewayExtraCatalog {
  unit_price_micros: number;
  // 兼容字段，仍然是 99。叠加 bulk_step_units 的规则后实际能买的最大是 80。
  max_units: number;
  prices: GatewayPeriodPrice[];
  // 1..bulk_step_units 任选，再往上只能选它的整数倍（20 → 40/60/80）。
  bulk_step_units?: number;
  requires_plan?: boolean;
  max_concurrent_paid_packs?: number;
  // 单位数规则的一句话（「可选 1–20，或 40、60、80」），和单位数选好之后
  // 那一行（「{units} 单位 = {units}× Starter 的用量…」，{units} 由客户端填）。
  units_rule_text?: string;
  units_text?: string;
  // 只在已登录的 GET /v1/plans 上有；服务端读买家状态失败时也会省略。
  // 按厂商卖之后它只是 Claude 那一份，给不认识厂商的老客户端用。
  eligibility?: GatewayExtraEligibility;
  // 每个厂商各一份：加量包要有同一家（或未绑定）的生效套餐才能买。读的时候
  // 走 extraForVendor()，别直接读这里。
  eligibility_by_vendor?: Record<string, GatewayExtraEligibility>;
}

export interface GatewayPlanCatalog {
  plans: GatewayCatalogPlan[];
  periods: GatewayCatalogPeriod[];
  extra: GatewayExtraCatalog;
  // 能买的厂商，按购买屏的顺序。报价和下单必须带其中一个，否则 400
  // vendor_required。老服务端不发 —— 那边没有厂商这回事，请求体里也不带。
  vendors?: string[];
  // 每一家叫什么、额度给哪些 app 用。购买流程里的厂商名一律取这里。
  vendor_details?: GatewayVendorDetail[];
  // 购买屏上陈述规则的那些句子，服务端按当前登录用户写好。
  copy?: GatewayPurchaseCopy;
}

export interface GatewayVendorDetail {
  id: string;
  label: string;
  blurb: string;
}

export interface GatewayPurchaseCopy {
  // 选厂商那一步下面的说明。
  vendor_note?: string;
  // 加量包怎么生效（加量包页标题、二维码页）。
  extra_effect?: string;
  // 按厂商、按这个用户此刻的状态写的意图卡片文案。extra_blocked 非空表示
  // 这一家的加量包现在买不了，内容就是原因。
  by_vendor?: Record<string, GatewayVendorPurchaseCopy>;
}

export interface GatewayVendorPurchaseCopy {
  subscription_title?: string;
  subscription_hint?: string;
  extra_hint?: string;
  extra_blocked?: string;
}

// fetchPlanCatalog 读购买屏要显示的全部价格。老网关的 /v1/plans 没有 prices /
// extra 字段，这里当成拿不到目录抛错 —— 宁可让购买屏显示「加载失败」，也不
// 在本地补算一份可能和扣款对不上的价格。
export async function fetchPlanCatalog(): Promise<GatewayPlanCatalog> {
  const catalog = await gatewayRequest<GatewayPlanCatalog>(
    "/v1/plans",
    { method: "GET" },
    true,
  );
  if (!catalog?.extra || catalog.plans.some((p) => !Array.isArray(p.prices))) {
    throw new Error("服务端版本过旧，无法获取价格");
  }
  return catalog;
}

// 报价和下单共用的请求体。两边必须一模一样，否则结账页报的价和实际扣的
// 就可能不是同一单。
//
// vendor 只在目录列了厂商时才传：老服务端不认这个字段。
interface PurchaseBody {
  period: string;
  units?: number;
  as_extra?: boolean;
  vendor?: string;
}

function purchaseBody(
  period: string,
  units: number | undefined,
  asExtra: boolean,
  vendor: string | undefined,
): PurchaseBody {
  const body: PurchaseBody = { period };
  if (vendor) {
    body.vendor = vendor;
  }
  if (asExtra) {
    body.as_extra = true;
    if (units !== undefined) {
      body.units = units;
    }
  }
  return body;
}

// 服务端算出来的一次换档结果。四种 action 的语义：
//   upgrade_now  低档 → 高档，立即生效，旧档剩余价值按天折成金额抵扣
//   renew        买的是当前正在生效的同一个档 → 就地延长现有 grant 的到期日,
//                不新建 grant、不重置周额度窗口。同档不存在「切换」这回事。
//   queue        高档 → 低档，排到当前订阅到期后生效，不可取消
//   activate_now 当前没有生效的订阅层，直接开通
//   extra        加量包，立即生效并与当前套餐额度叠加
//
// 客户端不复算其中任何一个数字。抵扣额取决于旧档「实付」金额、已用天数和
// 服务端的向上取整规则，本地算必然对不上，而一旦对不上，用户看到的价格和
// 实际扣款就会不同。
export interface GatewayPlanQuote {
  action: "upgrade_now" | "renew" | "queue" | "activate_now" | "extra";
  credit_applied_micros: number; // 旧档剩余价值 + 被吸收的排队档，抵扣了多少
  // 这一单花掉了多少**账户余额**。和 credit_applied_micros 是两回事，服务端
  // 分开给就是要求分开显示：前者是这次换档换算出来的，后者是账户里本来就有的
  // 钱。合成一个数字的话，用户看到余额少了却在页面上找不到任何一行解释它 ——
  // 这正是最容易变成工单的那类困惑。老服务端不发，所以可选。
  balance_applied_micros?: number;
  amount_due_micros: number; // 实际要付多少（可能为 0）
  amount_cents: number; // 微信收款金额（分）
  // 新套餐的生效日。**排队时不要拿当前生效档的到期日代替它** —— 服务端排到的是
  // 订阅层里最远的那个到期日（含已排队的档），已经排了一个降档时，两者会差一整个
  // 周期，用户会看到一个比实际早一个月的切换日期。可选是因为老服务端不发。
  new_valid_from?: string;
  new_valid_until: string; // 换档后的到期日
  resulting_balance_micros: number; // 换档后账户余额
  current_tier: string;
  target_tier: string;
  // 服务端写好的结账页文案。日期是占位符（{new_valid_from} / {new_valid_until}），
  // 客户端按本地时区填，见 fillServerText。
  //   headline   结账页主文案：这一单会发生什么
  //   summary    一句话说买的是什么（「换档到 Claude $200」），二维码页和零元单
  //              成功页用
  //   notice     需要醒目提示的风险（排队不退款），没有就是空串
  //   confirm_*  需要二次确认时的弹窗标题和正文，不需要时为空
  headline?: string;
  summary?: string;
  notice?: string;
  confirm_title?: string;
  confirm_message?: string;
}

// fetchPlanQuote 问服务端「现在下这一单会发生什么」。**纯只读** —— 不建订单、
// 不动 grant、不改余额，所以用户还在犹豫时可以随便调。
//
// 老服务端没有这个端点，会 404。这里**不** catch 成 null：调用方必须能分辨
// 「服务端没这个能力」（隐藏换档 UI，退回老流程）和「网络挂了」（提示重试），
// 两者的正确处理完全相反。GatewayApiError 已经带 status 和 code，直接抛。
export async function fetchPlanQuote(
  planId: string,
  period = "1m",
  units?: number,
  asExtra = false,
  vendor?: string,
): Promise<GatewayPlanQuote> {
  const body = purchaseBody(period, units, asExtra, vendor);
  return await gatewayRequest<GatewayPlanQuote>(
    `/v1/plans/${encodeURIComponent(planId)}/quote`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

// isPlanQuoteUnsupported 判断一次 fetchPlanQuote 的失败是不是「服务端没有换档
// 能力」。只认 404 —— 别的失败（401、网络中断）是暂时性的，把它们也当成
// 「不支持」会让换档 UI 因为一次网络抖动就消失。
export function isPlanQuoteUnsupported(error: unknown): boolean {
  return error instanceof GatewayApiError && error.status === 404;
}

// 下单响应。code_url 可选：抵扣额 ≥ 新套餐价时 amount_due_micros 为 0，
// 微信最小收款是 1 分，服务端不会下单，响应里就没有二维码。**分流一律看
// code_url 在不在**，不要看 order_id —— 服务端对零元单是否建 payment_orders
// 记录还没定，两种实现都要能工作。
export interface GatewayPlanOrder extends Omit<GatewayNativeOrder, "code_url"> {
  code_url?: string;
  plan_id: string;
  period: string;
  duration_days: number;
  months: number;
  // 服务端最终执行的动作，语义同 GatewayPlanQuote.action。老服务端不返回。
  action?: GatewayPlanQuote["action"];
  credit_applied_micros?: number;
  amount_due_micros?: number;
  new_valid_until?: string;
  resulting_balance_micros?: number;
  // 零元单带着报价的文案快照，语义同 GatewayPlanQuote.summary。
  summary?: string;
}

// createPlanOrder opens a WeChat Native order for a plan bought for one
// `period` (a key from the catalog's periods). The gateway computes the price authoritatively and,
// on the verified paid callback, grants the period's days.
//
// units 只在 asExtra 时有意义：加量包买几个单位。目录三档（starter/pro/
// business）的价格一律由服务端的目录决定 —— 用户不能自己给自己定价。
//
// asExtra 决定这一单动的是哪一层：false（默认）是订阅层，服务端按档位高低
// 自己判定立即换档还是排队；true 是加量包，永远立即生效并叠加。
//
// vendor 是买给哪一家（GatewayVendor）。换档、续费、排队都只看同一家的套餐，
// 买 GPT 不会动 Claude 那一份。目录没列厂商（老服务端）时不传。
//
// @param startAfterCurrent @deprecated 服务端现在自己判定续费该排队，这个参数
// 不再发送给服务端。位置留着不动是有意的 —— 把 asExtra 挪到第 4 位的话，还在
// 传 startAfterCurrent 的调用点会照常通过类型检查，但那个 true 会被当成
// 「买加量包」发出去，用户付了钱买到的不是他要的东西。宁可留一个死参数。
export async function createPlanOrder(
  planId: string,
  period = "1m",
  units?: number,
  startAfterCurrent?: boolean,
  asExtra = false,
  vendor?: string,
): Promise<GatewayPlanOrder> {
  void startAfterCurrent;
  const body = purchaseBody(period, units, asExtra, vendor);
  return await gatewayRequest<GatewayPlanOrder>(
    `/v1/plans/${encodeURIComponent(planId)}/orders`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

// fetchGatewaySubscription re-reads the current user's subscription (used after
// a plan is activated by the paid callback). The profile comes back alongside
// it so a caller can also refresh `email_verified`, which may have changed on
// another device or through a password reset — the cached login copy would
// otherwise stay stale until the next sign-in.
// 额度重置码兑换后返回的 `reset`：清零当前 5h，或清零当前周（连带 5h）。
// 窗口的起止时间不变，到点照常刷新。
export type GatewayQuotaReset = "reset_5h" | "reset_week";

// redeemPromoCode 兑换管理员发的兑换码。码是发给特定用户的，只有本人能用，
// 且只能用一次，过了兑换截止时间就不能用（410 promo_code_expired）。
// 两种码：套餐码开通一个套餐，和已有套餐叠加，不会顶掉已经买的东西；
// 额度重置码把当前窗口的已用量清零，返回里带 `reset`。
// 服务端做归一化（大小写、中划线、空格），所以这里原样传用户输入的内容。
export async function redeemPromoCode(code: string): Promise<{
  subscription: GatewaySubscriptionStatus;
  reset?: GatewayQuotaReset;
}> {
  return await gatewayRequest<{
    subscription: GatewaySubscriptionStatus;
    reset?: GatewayQuotaReset;
  }>(
    "/v1/promo-codes/redeem",
    { method: "POST", body: JSON.stringify({ code }) },
    true,
  );
}

// 管理员在后台设的版本门槛。两个都是 "x.y.z" 或空串（不限制 / 不提示）。
export interface GatewayClientVersionPolicy {
  min_version: string;
  suggest_version: string;
}

// fetchGatewayClientVersion 读版本门槛。接口是公开的，而且是网关唯一不会对
// 过旧版本回 426 的接口——被锁住的 App 正要靠它知道该升到哪个版本。
export async function fetchGatewayClientVersion(): Promise<GatewayClientVersionPolicy> {
  const data = await gatewayRequest<Partial<GatewayClientVersionPolicy>>(
    "/v1/client-version",
    { method: "GET" },
  );
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    min_version: text(data?.min_version),
    suggest_version: text(data?.suggest_version),
  };
}

export async function fetchGatewaySubscription(): Promise<{
  subscription: GatewaySubscriptionStatus;
  user?: GatewayUserProfile;
}> {
  return await gatewayRequest<{
    subscription: GatewaySubscriptionStatus;
    user?: GatewayUserProfile;
  }>("/v1/subscription", { method: "GET" }, true);
}

// --- Announcements ------------------------------------------------------------

export type GatewayAnnouncementLevel = "info" | "important";

export interface GatewayAnnouncement {
  id: string;
  title: string;
  body: string;
  level: GatewayAnnouncementLevel;
  // 两个都是空串表示没有链接按钮。
  link_url: string;
  link_label: string;
  published_at: string;
}

// fetchGatewayAnnouncements 拉取当前生效的公告，旧的在前。接口是公开的：没登录
// 的用户也要收到「服务维护」「请升级」这类消息，所以不带 token。
//
// 形状不对的条目直接丢掉，而不是让整批失败——一条坏数据不该挡住其余公告。
export async function fetchGatewayAnnouncements(): Promise<
  GatewayAnnouncement[]
> {
  const data = await gatewayRequest<{ announcements?: unknown }>(
    "/v1/announcements",
    { method: "GET" },
  );
  if (!Array.isArray(data?.announcements)) return [];
  return data.announcements.flatMap((raw): GatewayAnnouncement[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.title !== "string" ||
      typeof item.body !== "string"
    ) {
      return [];
    }
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return [
      {
        id: item.id,
        title: item.title,
        body: item.body,
        level: item.level === "important" ? "important" : "info",
        link_url: text(item.link_url),
        link_label: text(item.link_label),
        published_at: text(item.published_at),
      },
    ];
  });
}

// --- Email verification / password reset ------------------------------------

// sendEmailCode mails a six-digit code to the signed-in account's OWN address.
// The address is deliberately not a parameter: the server reads it from the
// account, so a stolen token cannot be used to mail codes anywhere else.
export async function sendEmailCode(): Promise<void> {
  await gatewayRequest<{ sent: boolean }>(
    "/v1/auth/email/send-code",
    { method: "POST", body: JSON.stringify({}) },
    true,
  );
}

// verifyEmail redeems the code and returns the updated profile (email_verified
// now true), so callers can refresh their cached copy without a second request.
export async function verifyEmail(code: string): Promise<GatewayUserProfile> {
  const res = await gatewayRequest<{ user: GatewayUserProfile }>(
    "/v1/auth/email/verify",
    { method: "POST", body: JSON.stringify({ code: code.trim() }) },
    true,
  );
  return res.user;
}

// forgotPassword asks for a reset code. Public — someone who has forgotten
// their password has no token to present. It answers the same 202 whether or
// not the address is registered, so resolving it says nothing about whether an
// account exists; the UI must not claim delivery is confirmed.
export async function forgotPassword(email: string): Promise<void> {
  await gatewayRequest<{ sent: boolean }>("/v1/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
}

// resetPassword sets a new password using the mailed code, and revokes the
// account's existing sessions server-side — so the caller must send the user
// back to the login screen rather than assume the current tokens still work.
export async function resetPassword(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<void> {
  await gatewayRequest<void>("/v1/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({
      email: input.email.trim().toLowerCase(),
      code: input.code.trim(),
      new_password: input.newPassword,
    }),
  });
}

// One usage window of GET /api/oauth/usage. `utilization` is a 0-100 percentage
// of the account's charged spend against the window cap; `resets_at` is when the
// window rolls over. A window is null when there is no active/valid entitlement.
export interface GatewayUsageWindow {
  utilization: number;
  resets_at?: string;
}

export interface GatewayUsage {
  five_hour: GatewayUsageWindow | null;
  seven_day: GatewayUsageWindow | null;
  // 按模型族的份额上限（服务端 #256），例如 Fable 最多占总额度的 50%。
  // 老服务端没有这个字段，读的时候一律 `?? []`。
  model_caps?: GatewayModelCap[];
}

// 一个模型族在一个窗口里的份额用量。utilization 和上面的总额度同一个定义：
// 到 100% 的那一刻就是这类模型开始被拒（429 model_share_exceeded）的那一刻。
export interface GatewayModelCapWindow {
  utilization: number;
  resets_at?: string;
  cap_micros: number;
  charged_micros: number;
}

export interface GatewayModelCap {
  id: string;
  label: string;
  // 模型 id 前缀，如 "claude-fable-"。这一族所有版本共享同一份额度。
  match: string;
  // 占总额度的比例，基点（5000 = 50%）。
  share_bps: number;
  five_hour: GatewayModelCapWindow | null;
  seven_day: GatewayModelCapWindow | null;
}

const USAGE_CACHE_KEY = "llm-gateway-usage-cache";

export interface CachedGatewayUsage {
  usage: GatewayUsage;
  fetchedAt: number; // epoch ms
}

export function saveGatewayUsageCache(usage: GatewayUsage): void {
  localStorage.setItem(
    USAGE_CACHE_KEY,
    JSON.stringify({
      usage,
      fetchedAt: Date.now(),
    } satisfies CachedGatewayUsage),
  );
}

export function loadGatewayUsageCache(): CachedGatewayUsage | null {
  const raw = localStorage.getItem(USAGE_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedGatewayUsage;
  } catch {
    return null;
  }
}

export function clearGatewayUsageCache(): void {
  localStorage.removeItem(USAGE_CACHE_KEY);
}

// fetchGatewayUsage reads the account-level quota utilization the gateway meters
// for the logged-in user (5h + weekly windows). It hits GET /api/oauth/usage
// with the login token directly, so the dock shows ONE account total for our
// custom plan — the same number the provider footer derives from the same
// endpoint — instead of a per-provider figure.
export async function fetchGatewayUsage(): Promise<GatewayUsage> {
  return gatewayRequest<GatewayUsage>(
    "/api/oauth/usage",
    { method: "GET" },
    true,
  );
}

// --- Organization projects ----------------------------------------------------
//
// 组织成员可以属于多个项目，每个项目一份额度，请求只扣**当前项目**的。当前项目
// 存在服务端，对该用户所有设备生效。**只有百分比，没有金额** —— 和个人套餐的
// 用量条同一个理由。不是组织成员的用户完全不碰这一块。

export interface GatewayProjectWindow {
  // 一位小数，如 41.5。没有额度的项目是 0（不是 100），以 has_allowance 判断。
  used_percent: number;
  // null：窗口还没开始（这个 5 小时块里还没有请求）。
  resets_at?: string | null;
}

export interface GatewayOrgProject {
  id: string;
  name: string;
  // false：这个项目没有给该成员分配额度。窗口此时可能为 null。
  has_allowance: boolean;
  five_hour: GatewayProjectWindow | null;
  week: GatewayProjectWindow | null;
}

export interface GatewayOrganization {
  organization: { name: string };
  // null：组织成员还没有被加入任何项目。
  current_project_id: string | null;
  projects: GatewayOrgProject[];
}

// fetchGatewayOrganization 读当前用户的组织与项目。不是组织成员返回 null。
//
// 404 一律当「不是组织成员」：服务端明确说 not_org_member 是 404，老网关根本
// 没有这个接口也是 404 —— 两种情况 app 都该和今天一模一样。其它错误照常抛，
// 调用方据此保留上一次的缓存，而不是把组织成员误当成个人用户。
export async function fetchGatewayOrganization(): Promise<GatewayOrganization | null> {
  try {
    return await gatewayRequest<GatewayOrganization>(
      "/v1/me/organization",
      { method: "GET" },
      true,
    );
  } catch (error) {
    if (error instanceof GatewayApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

// switchGatewayProject 切换当前项目。不是该用户所在的项目时服务端回 403
// project_forbidden（多半是刚被移出），由调用方提示并重拉列表。
export async function switchGatewayProject(
  projectId: string,
): Promise<{ current_project_id: string }> {
  return gatewayRequest<{ current_project_id: string }>(
    "/v1/me/organization/project",
    { method: "PUT", body: JSON.stringify({ project_id: projectId }) },
    true,
  );
}

// 组织信息的本地缓存。启动时先用它渲染，组织成员打开面板就不会先闪一下个人
// 账号的界面（「我的套餐」「购买套餐」）再跳成项目界面。
const ORG_CACHE_KEY = "llm-gateway-org-cache";

export interface CachedGatewayOrganization {
  org: GatewayOrganization | null;
  fetchedAt: number; // epoch ms
}

export function saveGatewayOrgCache(org: GatewayOrganization | null): void {
  localStorage.setItem(
    ORG_CACHE_KEY,
    JSON.stringify({
      org,
      fetchedAt: Date.now(),
    } satisfies CachedGatewayOrganization),
  );
}

export function loadGatewayOrgCache(): CachedGatewayOrganization | null {
  const raw = localStorage.getItem(ORG_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedGatewayOrganization;
  } catch {
    return null;
  }
}

export function clearGatewayOrgCache(): void {
  localStorage.removeItem(ORG_CACHE_KEY);
}

// setSecretRedaction 开关「发送前隐藏密钥」。返回刷新后的个人资料，里面的
// redact_secrets 就是服务端生效的值 —— 以它为准，不用本地的开关状态。
export async function setSecretRedaction(
  enabled: boolean,
): Promise<GatewayUserProfile> {
  const res = await gatewayRequest<{ user: GatewayUserProfile }>(
    "/v1/account/secret-redaction",
    { method: "PUT", body: JSON.stringify({ enabled }) },
    true,
  );
  return res.user;
}

// setToolCompression 开关「压缩工具输出」。和 setSecretRedaction 一样，以返回
// 资料里的 tool_compression 为准。
export async function setToolCompression(
  enabled: boolean,
): Promise<GatewayUserProfile> {
  const res = await gatewayRequest<{ user: GatewayUserProfile }>(
    "/v1/account/tool-compression",
    { method: "PUT", body: JSON.stringify({ enabled }) },
    true,
  );
  return res.user;
}

// fetchTokensSaved：压缩累计替用户省下的输入 token 数（服务端 #261），只算真正
// 压缩过的请求。只在开关打开时调用；老服务端没有这个接口会 404，调用方不显示。
export async function fetchTokensSaved(): Promise<number> {
  const res = await gatewayRequest<{ tokens_saved: number }>(
    "/v1/account/tokens-saved",
    { method: "GET" },
    true,
  );
  return res.tokens_saved;
}
