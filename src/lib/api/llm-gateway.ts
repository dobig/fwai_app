import {
  CLIENT_UPGRADE_HEADER,
  CLIENT_VERSION_HEADER,
  CLIENT_VERSION_VALUE,
  recordUpgradeSignal,
} from "@/lib/clientUpgrade";

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
}

export interface GatewayAccountProfile {
  id: string;
}

// 一个 grant 的角色。subscription 是订阅层（同时只有一张生效，可换档），
// extra 是临时加量包（叠加，自然到期，不参与换档判定）。
export type GatewayPlanRole = "subscription" | "extra";

// 一个独立计量的套餐。套餐可叠加，用户同时可以持有多个。
// pending 为 true 表示这个套餐还没开始生效（排队中）。
export interface GatewaySubscriptionPlan {
  grant_id: string;
  tier: string;
  usage_micros_per_5h: number;
  usage_micros_per_week: number;
  valid_from: string;
  valid_until: string;
  pending?: boolean;
  // 老服务端不返回这个字段 —— 和 plans 本身可选是同一个先例。
  // 读取一律走 planRole()，别直接读这里。
  role?: GatewayPlanRole;
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

export function saveGatewayLogin(login: GatewayLoginResult): void {
  saveGatewayTokens(login);
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(login));
}

export function clearGatewayLogin(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(LOGIN_STORAGE_KEY);
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

  constructor(status: number, code: string) {
    super(
      code
        ? `llm_gateway request failed: ${status} (${code})`
        : `llm_gateway request failed: ${status}`,
    );
    this.name = "GatewayApiError";
    this.status = status;
    this.code = code;
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
    try {
      const body = (await response.clone().json()) as unknown;
      if (body && typeof body === "object") {
        const rec = body as Record<string, unknown>;
        const val = rec.error ?? rec.message;
        if (val != null) detail = String(val);
      }
    } catch {
      // Non-JSON error body; fall back to the status code alone.
    }
    throw new GatewayApiError(response.status, detail);
  }
  // 204 and other empty successes have no body to parse; password reset answers
  // 204, and an unconditional json() would turn a success into a thrown error.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function loginGateway(input: {
  username: string;
  password: string;
  deviceName: string;
  platform: string;
}): Promise<GatewayLoginResult> {
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

// revokeGatewayToken invalidates the stored refresh token server-side
// (POST /oauth/revoke). All access tokens bound to it die with it.
export async function revokeGatewayToken(): Promise<void> {
  const current = loadGatewayTokens();
  if (!current?.refresh_token) return;
  // Direct fetch: the endpoint answers 204 No Content, which gatewayRequest's
  // unconditional response.json() would choke on.
  const response = await fetch(`${getGatewayBaseURL()}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  });
  if (!response.ok) {
    throw new Error(`llm_gateway revoke failed: ${response.status}`);
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

// 服务端算出来的一次换档结果。四种 action 的语义：
//   upgrade_now  低档 → 高档，立即生效，旧档剩余价值按天折成金额抵扣
//   queue        同档（续费）或高档 → 低档，排到当前订阅到期后生效，不可取消
//   activate_now 当前没有生效的订阅层，直接开通
//   extra        加量包，立即生效并与当前套餐额度叠加
//
// 客户端不复算其中任何一个数字。抵扣额取决于旧档「实付」金额、已用天数和
// 服务端的向上取整规则，本地算必然对不上，而一旦对不上，用户看到的价格和
// 实际扣款就会不同。
export interface GatewayPlanQuote {
  action: "upgrade_now" | "queue" | "activate_now" | "extra";
  credit_applied_micros: number; // 旧档剩余价值抵扣了多少
  amount_due_micros: number; // 实际要付多少（可能为 0）
  amount_cents: number; // 微信收款金额（分）
  new_valid_until: string; // 换档后的到期日
  resulting_balance_micros: number; // 换档后账户余额
  current_tier: string;
  target_tier: string;
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
  priceUSD?: number,
  asExtra = false,
): Promise<GatewayPlanQuote> {
  const body: { period: string; price_usd?: number; as_extra?: boolean } = {
    period,
  };
  if (priceUSD !== undefined) {
    body.price_usd = priceUSD;
  }
  if (asExtra) {
    body.as_extra = true;
  }
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
}

// createPlanOrder opens a WeChat Native order for a plan bought for one
// `period` (see PERIODS). The gateway computes the price authoritatively and,
// on the verified paid callback, grants the period's days. For the "custom"
// plan, priceUSD is the buyer-chosen whole-dollar MONTHLY price
// (server-validated to $10–$199 and below the top tier) regardless of the
// period bought; it is ignored for catalog plans.
//
// asExtra 决定这一单动的是哪一层：false（默认）是订阅层，服务端按档位高低
// 自己判定立即换档还是排队；true 是加量包，永远立即生效并叠加。
//
// @param startAfterCurrent @deprecated 服务端现在自己判定续费该排队，这个参数
// 不再发送给服务端。位置留着不动是有意的 —— 把 asExtra 挪到第 4 位的话，还在
// 传 startAfterCurrent 的调用点会照常通过类型检查，但那个 true 会被当成
// 「买加量包」发出去，用户付了钱买到的不是他要的东西。宁可留一个死参数。
export async function createPlanOrder(
  planId: string,
  period = "1m",
  priceUSD?: number,
  startAfterCurrent?: boolean,
  asExtra = false,
): Promise<GatewayPlanOrder> {
  void startAfterCurrent;
  const body: { period: string; price_usd?: number; as_extra?: boolean } = {
    period,
  };
  if (priceUSD !== undefined) {
    body.price_usd = priceUSD;
  }
  if (asExtra) {
    body.as_extra = true;
  }
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
// redeemPromoCode 兑换管理员发的兑换码。码是发给特定用户的，只有本人能用，
// 且只能用一次。兑换出来的套餐和已有套餐叠加，不会顶掉已经买的东西。
// 服务端做归一化（大小写、中划线、空格），所以这里原样传用户输入的内容。
export async function redeemPromoCode(
  code: string,
): Promise<{ subscription: GatewaySubscriptionStatus }> {
  return await gatewayRequest<{ subscription: GatewaySubscriptionStatus }>(
    "/v1/promo-codes/redeem",
    { method: "POST", body: JSON.stringify({ code }) },
    true,
  );
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
