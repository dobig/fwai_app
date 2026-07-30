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

// 一个独立计量的套餐。套餐可叠加，用户同时可以持有多个。
// pending 为 true 表示这个套餐买的时候选了「到期后生效」，现在还没开始。
export interface GatewaySubscriptionPlan {
  grant_id: string;
  tier: string;
  usage_micros_per_5h: number;
  usage_micros_per_week: number;
  valid_from: string;
  valid_until: string;
  pending?: boolean;
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
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
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

// createPlanOrder opens a real WeChat Native order for a plan bought for one
// `period` (see PERIODS). The gateway computes the price authoritatively (full
// share of the monthly price as credit, discounted charge) and, on the verified
// paid callback, grants the period's days. For the "custom" plan, priceUSD is
// the buyer-chosen whole-dollar MONTHLY price (server-validated to $10–$199 and
// below the top tier) regardless of the period bought; it is ignored for
// catalog plans.
//
// startAfterCurrent 决定这一单和已有套餐的关系：默认（false）立刻叠加，
// 额度相加；true 则排到当前套餐到期后再生效。纯续费该用 true —— 并行跑
// 的话那份额度用不完就白费了。
export async function createPlanOrder(
  planId: string,
  period = "1m",
  priceUSD?: number,
  startAfterCurrent = false,
): Promise<
  GatewayNativeOrder & {
    plan_id: string;
    period: string;
    duration_days: number;
    months: number;
  }
> {
  const body: {
    period: string;
    price_usd?: number;
    start_after_current?: boolean;
  } = { period };
  if (priceUSD !== undefined) {
    body.price_usd = priceUSD;
  }
  if (startAfterCurrent) {
    body.start_after_current = true;
  }
  return await gatewayRequest<
    GatewayNativeOrder & {
      plan_id: string;
      period: string;
      duration_days: number;
      months: number;
    }
  >(
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
