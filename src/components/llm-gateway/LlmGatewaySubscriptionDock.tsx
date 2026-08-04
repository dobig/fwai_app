import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  MailCheck,
  Plug,
  RefreshCw,
  ShoppingBag,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { providersApi } from "@/lib/api";
import { useActiveApp } from "@/components/active-app-provider";
import { useForwardingQuery } from "@/lib/query";
import {
  APP_DISPLAY_NAME,
  FORWARDABLE_APPS,
  forwardingFlagKey,
  isForwardable,
  type ForwardableApp,
} from "@/lib/apps";
import type { Provider } from "@/types";
import {
  clearGatewayLogin,
  createPlanOrder,
  fetchPlanQuote,
  isPlanQuoteUnsupported,
  redeemPromoCode,
  fetchGatewaySubscription,
  fetchGatewayUsage,
  forgotPassword,
  gatewayOAuthAccessToken,
  GatewayApiError,
  getGatewayBaseURL,
  getPaymentOrder,
  loadGatewayLogin,
  loginGateway,
  refreshGatewayToken,
  resetPassword,
  revokeGatewayToken,
  saveGatewayLogin,
  saveGatewayUsageCache,
  loadGatewayUsageCache,
  planRole,
  clearGatewayUsageCache,
  registerGateway,
  sendEmailCode,
  setGatewayBaseURL,
  verifyEmail,
  type GatewayLoginResult,
  type GatewayPlanQuote,
  type GatewaySubscriptionStatus,
  type GatewayUsage,
  type GatewayUsageWindow,
  type GatewayUserProfile,
} from "@/lib/api/llm-gateway";
import { useClientUpgradeSignal } from "@/lib/clientUpgrade";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PlanCheckout } from "./PlanCheckout";
import { PlanSections } from "./PlanSections";
import {
  TIERS,
  formatMicrosUSD,
  formatPlanDate,
  planLabel,
  tierBlurb,
  tierDescription,
} from "./planCatalog";
// 这些全部是**预览用**的价格逻辑。实付金额一律取服务端：结账页取 quote 的
// amount_due_micros，二维码页取下单响应的 amount_credits。
import {
  DEFAULT_PERIOD,
  PERIODS,
  findPeriod,
  periodDiscountLabel,
  periodsFor,
  previewTotalUSD,
  previewUnitUSD,
} from "./planPeriods";

type Screen =
  | "auth"
  | "account"
  | "purchase"
  | "redeem"
  | "verify-email"
  | "forgot-password";
type AuthMode = "login" | "register";

// Mirrors the gateway's own 60s resend cooldown. The server is authoritative —
// this only greys out the button so the common case is a countdown rather than
// a 429.
const SEND_CODE_COOLDOWN_SECONDS = 60;

// Gateway error codes rendered in Chinese. Anything not listed falls back to a
// per-call-site default, so an unmapped code still says something useful.
const EMAIL_ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "验证码不正确",
  code_expired: "验证码已过期，请重新发送",
  too_many_attempts: "错误次数过多，请重新发送验证码",
  code_send_cooldown: "发送太频繁，请稍后再试",
  email_already_verified: "邮箱已验证",
  weak_password: "密码至少 8 位",
  invalid_request: "请填写完整信息",
};

// The gateway's error code for a failed request, or "" when the failure was not
// a gateway response at all (network down, offline). Branching on this beats
// matching the message text, which is how a /401/ test came to also fire on any
// message that merely contained "401".
function gatewayErrorCode(error: unknown): string {
  return error instanceof GatewayApiError ? error.code : "";
}

function gatewayErrorStatus(error: unknown): number {
  return error instanceof GatewayApiError ? error.status : 0;
}

function emailErrorMessage(error: unknown, fallback: string): string {
  return EMAIL_ERROR_MESSAGES[gatewayErrorCode(error)] ?? fallback;
}

// 一次服务端订阅读取的结果。读取函数在拿不到答案时返回 null——「没问到」和
// 「问到了、确实没开通」必须分开，前者不能当成没套餐去催用户购买。
interface SubscriptionRead {
  subscription: GatewaySubscriptionStatus;
  user?: GatewayUserProfile;
}

interface PendingOrder {
  orderId: string;
  // 零元单（抵扣额 ≥ 新套餐价）没有二维码：服务端不下微信单。渲染前必须判空，
  // 否则会画出一个扫不出东西的空码。完整的无二维码路径见 #12。
  codeURL?: string;
  planId: string;
  period: string;
  // 二维码上方那行金额，**取服务端下单响应里的 amount_credits**（micro-USD）。
  // 本地那套预览价不参与 —— 换档时它必然偏高（不含任何抵扣），而扫码扣的是
  // 服务端算出来的数，两个数字对不上是最伤信任的一类 bug。见 #13。
  amountMicros: number;
  // Monthly price for the custom plan (label + retry context); catalog plans
  // derive it from TIERS.
  priceUSD?: number;
  // 这一单动的是加量包还是订阅层。只用于二维码页的文案 —— 排队与否由服务端
  // 判定并通过 quote 的 action 表达，客户端不再自己选。
  asExtra?: boolean;
}

// 购买意图。订阅层走换档判定（服务端按档位高低决定立即生效还是排队），
// 加量包永远立即生效并叠加。两者在服务端靠 as_extra 区分，所以客户端必须
// 让用户先表达意图 —— 同一个「买套餐」动作在新模型下有两种完全不同的含义。
type PurchaseIntent = "subscription" | "extra";

// 加量包是独立 SKU：1 单位 = 月费 $20（5h $20 / 周 $100），N 单位线性放大，
// 无折扣。服务端的报价/下单入参里没有「单位数」这个字段，只有 price_usd，
// 所以 N 通过月价表达：price_usd = 20 × N。
//
// plan id 就是 "extra"，与已删除的自选金额档没有任何关系。这里一度写成
// CUSTOM_TIER_ID —— #189 定义了定价公式却没写明 as_extra=true 时 plan id 填什么，
// 当时按「买家自报月价」猜到了 custom 那条路径上。能跑通纯粹是被服务端救了：
// `if body.AsExtra { planID = extraPlanID }` 第一步就把 URL 里的 id 丢弃。
// 契约已在 llm_gateway#189 的评论里写死：as_extra 时服务端强制改写为 extra，
// quote.target_tier 和 grant 的 plan_id 回读都是 "extra"。
const EXTRA_PLAN_ID = "extra";
const EXTRA_UNIT_USD = 20;
const EXTRA_MAX_UNITS = 99;

// 已确定要买什么，等着结账页确认的那一单。quote 和下单参数绑在一起存，
// 免得用户在结账页停留时改了别处的选择、付款用的却是另一份报价。
interface CheckoutDraft {
  planId: string;
  period: string;
  priceUSD?: number;
  asExtra: boolean;
  quote: GatewayPlanQuote;
}

// 零元单结清后的成功态。
//
// 抵扣额 ≥ 新套餐价时服务端**不下微信单**（微信最小收款 1 分），响应里没有
// code_url。这条路径不能渲染二维码、不能启动轮询 —— 轮询一个可能根本不存在
// 的订单会让用户永远停在「等待支付…」。
//
// 用户一分钱没付，但套餐确实变了，所以成功提示要说清发生了什么：换成了哪一
// 档、新到期日是哪天、还剩多少余额。只说「购买成功」的话，用户会以为没生效。
interface SettledOrder {
  action: GatewayPlanQuote["action"];
  targetTier: string;
  newValidUntil?: string;
  resultingBalanceMicros?: number;
}

function parseExtraUnits(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > EXTRA_MAX_UNITS) return null;
  return n;
}

const GATEWAY_PROVIDER_ID = "llm-gateway-local";
const DOCK_OPEN_KEY = "llm-gateway-dock-open";

function initials(name: string): string {
  return (name || "U").slice(0, 2).toUpperCase();
}

// Rough age label for the stale-usage hint, e.g. "3 分钟前" / "2 小时前".
function formatStaleAge(fetchedAt: number): string {
  const mins = Math.max(1, Math.floor((Date.now() - fetchedAt) / 60_000));
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// Short local time for a usage window's reset instant, e.g. "7月19 15:00".
function formatReset(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// One account-usage window rendered as a labelled utilization bar. Turns red as
// it approaches the cap so users notice before they run out.
function UsageBar({
  label,
  window: w,
}: {
  label: string;
  window: GatewayUsageWindow;
}) {
  const pct = Math.max(0, Math.min(100, w.utilization));
  const near = pct >= 90;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={near ? "font-semibold text-red-500" : "text-foreground"}
        >
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${near ? "bg-red-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {w.resets_at && (
        <div className="mt-0.5 text-right text-[10px] text-muted-foreground">
          {formatReset(w.resets_at)} 重置
        </div>
      )}
    </div>
  );
}

// Screen slides in from the right each time it mounts (keyed on screen name).
function ScreenView({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  return (
    <div
      className={`transition-all duration-300 ease-out ${
        shown ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

export function LlmGatewaySubscriptionDock() {
  const [open, setOpen] = useState(
    () => localStorage.getItem(DOCK_OPEN_KEY) === "1",
  );
  const [login, setLogin] = useState<GatewayLoginResult | null>(
    loadGatewayLogin(),
  );
  const [screen, setScreen] = useState<Screen>(login ? "account" : "auth");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [errors, setErrors] = useState<{
    user?: boolean;
    mail?: boolean;
    pass?: boolean;
  }>({});
  const [busy, setBusy] = useState(false);
  const [fwdBusy, setFwdBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [pending, setPending] = useState<PendingOrder | null>(null);
  // Two-step purchase: pick a tier, then pick the period before the QR.
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(DEFAULT_PERIOD);
  // 换档/续费还是补额度。默认订阅层 —— 大多数人要的是换档或续费，
  // 而买错方向的代价不对称：想换档买成加量包的话，旧档照常计费到期。
  const [intent, setIntent] = useState<PurchaseIntent>("subscription");
  // 加量包买几个单位。
  const [extraUnitsInput, setExtraUnitsInput] = useState("1");
  // 结账页。选完档位和周期后拉一次 quote，把抵扣额/新到期日/剩余余额/实付
  // 四个数字摆给用户看，再让他付款。**只在点「下一步」时拉** —— 每改一次
  // 选项就拉一次会让网络慢的用户看到数字闪烁。
  const [checkout, setCheckout] = useState<CheckoutDraft | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // 服务端支不支持换档。null = 还没探过。
  //
  // 探测是**惰性**的：第一次拉报价拿到 404 才知道。不在挂载时主动探一次，
  // 因为那要么得先编一组套餐参数去 POST（会在服务端日志里留下无意义的报价
  // 请求），要么得等一个新端点。代价是老网关下第一次点「下一步」会白跑一次
  // 请求然后退回旧流程 —— 用户看到的仍是能用的购买流程，只是没有结账页。
  const [quoteSupported, setQuoteSupported] = useState<boolean | null>(null);
  // 服务端说这个客户端版本太老。只挡购买 —— 转发 AI 流量和其它功能照常，
  // 把整个客户端锁死会造成一批用户既用不了也不知道为什么，而他们的订阅还
  // 在计费。
  const upgradeRequired = useClientUpgradeSignal() === "required";
  // 排队（降档/续费）不退款、不可取消，点付款前再拦一道。
  const [confirmQueue, setConfirmQueue] = useState(false);
  // 零元单（余额抵扣够了）直接结清，没有二维码这一步。
  const [settled, setSettled] = useState<SettledOrder | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  // Editable gateway base URL. Seeded from the persisted value (or the baked
  // default) so users can point the client at the right gateway before logging
  // in — the redesign previously had no way to change it.
  const [gatewayURL, setGatewayURL] = useState(getGatewayBaseURL());
  // Email verification + password reset. `codeCooldown` counts down the resend
  // button; `resetEmail` is separate from `email` so a half-typed registration
  // address is not clobbered by a password-reset detour and vice versa.
  const [emailCode, setEmailCode] = useState("");
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [resetRequested, setResetRequested] = useState(false);
  const onActivatedRef = useRef<() => Promise<void>>(async () => {});

  // 转发只作用于当前选中的那个 CLI：Claude 走网关时，Codex 的配置一个字节都
  // 不该动。每个 app 的转发状态相互独立，可以同时开着；面板显示的始终是当前
  // 选中那个的状态。
  const queryClient = useQueryClient();
  const { activeApp } = useActiveApp();
  const target: ForwardableApp | null = isForwardable(activeApp)
    ? activeApp
    : null;
  const activeAppName = APP_DISPLAY_NAME[activeApp];
  const { data: forwardingData } = useForwardingQuery(activeApp);
  const forwarding = target ? (forwardingData ?? false) : false;

  const subscription = login?.subscription;
  const isActive = Boolean(subscription?.active);
  // 用户持有的套餐列表（含待生效的）。服务端已按到期时间排好，先到期的
  // 在前——那也是先被扣额度的那一层。老服务端不返回这个字段，取空数组，
  // 展示逻辑会退回单套餐那一行。
  const planList = subscription?.plans ?? [];
  // 有没有生效的**订阅层**。这曾经是「能不能买加量包」的判据 —— 服务端要求
  // 底下必须垫一个订阅层，否则 409。那个前置已经取消（赠送的额度是 extra
  // 角色，被赠送的用户根本没有订阅层，却最该能加量），所以这个标志现在**只
  // 决定文案**：有档位时说「更换 / 续费」，没有时说「购买」。
  // 老服务端不返回 role 也不返回 plans，退回看 isActive。
  const hasActiveSubscriptionTier =
    planList.length > 0
      ? planList.some((p) => planRole(p) === "subscription" && !p.pending)
      : isActive;
  // Treat a login saved before this field existed as verified: those accounts
  // were backfilled verified by migration 0020, and defaulting to "unverified"
  // would show an existing paying customer a badge telling them to verify an
  // address the server already accepts. The next /v1/subscription read replaces
  // the cached copy with the server's answer either way.
  const emailVerified = login?.user.email_verified !== false;
  // Account-level usage (5h + weekly windows) for our custom plan, read straight
  // from the gateway with the login token so the dock shows one total that
  // matches what the provider footer derives from the same endpoint.
  const [usage, setUsage] = useState<GatewayUsage | null>(
    () => loadGatewayUsageCache()?.usage ?? null,
  );
  const [usageFetchedAt, setUsageFetchedAt] = useState<number | null>(
    () => loadGatewayUsageCache()?.fetchedAt ?? null,
  );
  // 超过 10 分钟未成功刷新即视为过时：变灰并标注时间，避免陈旧值被当成实时值。
  const usageIsStale =
    usageFetchedAt != null && Date.now() - usageFetchedAt > 10 * 60 * 1000;

  useEffect(() => {
    localStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0");
  }, [open]);

  // Refresh the account usage whenever the dock is open on the account screen
  // for a logged-in user. Cheap GET; keeps the number current after purchases
  // or forwarding toggles without a manual refresh.
  //
  // A 401 means the stored access token died (revoked by a rotation on
  // another device, or a legacy expiring token). Quietly exchanging the
  // refresh token and retrying once makes the quota display self-healing;
  // only when that also fails do we tell the user to log in again — the old
  // behaviour of silently hiding the bars looked like a broken app.
  useEffect(() => {
    if (!open || screen !== "account" || !login) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchGatewayUsage();
        saveGatewayUsageCache(u);
        if (!cancelled) {
          setUsage(u);
          setUsageFetchedAt(Date.now());
        }
      } catch (error) {
        if (gatewayErrorStatus(error) !== 401) {
          // Not fatal — leave the last value and let the next open retry.
          return;
        }
        try {
          await refreshGatewayToken();
          const u = await fetchGatewayUsage();
          saveGatewayUsageCache(u);
          if (!cancelled) {
            setUsage(u);
            setUsageFetchedAt(Date.now());
          }
          if (target) await syncGatewayProviderEntry(target);
        } catch {
          if (!cancelled) {
            toast.error("登录已过期，请重新登录");
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, screen, login, isActive, target]);

  // 面板每次打开重读一次转发状态：用户可能在供应商列表里手动切走，后端那边
  // 备份已经作废了，不重新读就会一直显示「结束转发」，点下去反而把陈旧的
  // token 盖回去。
  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({ queryKey: ["forwarding", activeApp] });
  }, [open, activeApp, queryClient]);

  // 切 app 不动上一个的转发状态。
  //
  // 隔离之后每个 app 的配置互不影响，切走还去停掉就是多余的干预——用户在 Claude
  // 上开了转发，切去 Codex 看一眼再切回来，转发本就该还在。切走时看不见它在转发
  // 没关系，切回来就看见了。
  //
  // 关掉转发只有一个入口：用户自己点「结束转发」（以及登出/改密码时的批量清理，
  // 那时 token 已经失效，留着凭据只会让 CLI 一直 401）。

  // 按规则 1 确保网关条目在当前 app 的列表里。切 app 时也补一次——每个 app 的
  // 列表是分开的。
  useEffect(() => {
    if (!target) return;
    void ensureGatewayProviderListed(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // 发送验证码后的冷却倒计时。只是把按钮灰掉——服务端的 60 秒冷却才是权威。
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = setTimeout(() => setCodeCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [codeCooldown]);

  // ---- provider install / restore ------------------------------------------

  function buildGatewayProvider(app: ForwardableApp): Provider {
    const token = gatewayOAuthAccessToken();
    const base = getGatewayBaseURL().replace(/\/+$/, "");
    if (app === "claude") {
      return {
        id: GATEWAY_PROVIDER_ID,
        name: "LLM Gateway",
        category: "custom",
        websiteUrl: base,
        settingsConfig: {
          env: {
            ANTHROPIC_AUTH_TOKEN: token,
            ANTHROPIC_BASE_URL: base,
          },
        },
        notes: `Endpoint: ${base}/v1/chat/completions`,
        createdAt: Date.now(),
      };
    }
    return {
      id: GATEWAY_PROVIDER_ID,
      name: "LLM Gateway",
      category: "custom",
      websiteUrl: base,
      settingsConfig: {
        auth: { OPENAI_API_KEY: token },
        config: `model_provider = "llm_gateway"
model = "gpt-5.4"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.llm_gateway]
name = "llm_gateway"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = true`,
      },
      notes: `Endpoint: ${base}/v1/responses`,
      createdAt: Date.now(),
    };
  }

  // 规则 1：确保 LLM Gateway 出现在当前 app 的供应商列表里。
  // 只在缺失时补条目（不覆盖已有、不切换、不写 live）。
  //
  // 只补当前选中的那个 app：后端的 add 在「该 app 还没有当前供应商」时会顺手
  // 把新条目设成当前并写 live，两个 app 都补就等于替用户碰了他没选的那个 CLI
  // 的配置文件。
  async function ensureGatewayProviderListed(
    app: ForwardableApp,
  ): Promise<void> {
    try {
      const providers = await providersApi.getAll(app);
      if (!providers[GATEWAY_PROVIDER_ID]) {
        await providersApi.add(buildGatewayProvider(app), app, false);
      }
    } catch {
      // Non-Tauri env or read failure — the next mount retries.
    }
  }

  // token 刷新后把新 token 写进条目。
  //
  // 转发开着时必须走 refreshForwardingCredentials 这条窄路径：转发期间 update
  // 是整文件写（用户在编辑页的改动要能落盘），而这里传的
  // buildGatewayProvider 是只有凭据的最小配置，整份写出去会把用户的 live 削光。
  // 窄路径只覆盖 endpoint + key，其余字节不动。
  //
  // 同样只处理当前 app：按「最多一个 app 在转发且必然是当前这个」的不变量，
  // 也只有它可能把网关条目设成当前，也就只有它需要落新 token。
  async function syncGatewayProviderEntry(app: ForwardableApp): Promise<void> {
    try {
      const providers = await providersApi.getAll(app);
      if (!providers[GATEWAY_PROVIDER_ID]) return;

      if (await providersApi.isForwarding(app)) {
        const token = gatewayOAuthAccessToken();
        const base = getGatewayBaseURL().replace(/\/+$/, "");
        if (token) {
          await providersApi.refreshForwardingCredentials(app, token, base);
        }
        return;
      }

      await providersApi.update(buildGatewayProvider(app), app);
    } catch {
      // best-effort
    }
  }

  // 仅登出时使用：清掉条目与（若正在启用的）live 配置。规则 1 会在下次
  // 打开 app 时重新补条目，但登出后的机器上不应留下带凭据的供应商。
  async function removeGatewayProvider(): Promise<void> {
    try {
      await providersApi.removeManaged(GATEWAY_PROVIDER_ID, "claude");
    } catch {
      // The provider may not exist yet; cleanup should stay idempotent.
    }
    try {
      await providersApi.removeManaged(GATEWAY_PROVIDER_ID, "codex");
    } catch {
      // Same idempotency for the codex side.
    }
  }

  async function startForwarding(app: ForwardableApp): Promise<void> {
    const token = gatewayOAuthAccessToken();
    // 规则 2：没登录不能开启转发。
    if (!login || !token) {
      toast.error("请先登录");
      return;
    }
    setFwdBusy(true);
    try {
      // 「登录」必须是活会话：401 先试 refresh，不行就打回登录页。
      try {
        await fetchGatewayUsage();
      } catch (error) {
        if (gatewayErrorStatus(error) === 401) {
          try {
            await refreshGatewayToken();
          } catch {
            toast.error("登录已过期，请重新登录后再开启转发");
            clearGatewayLogin();
            setLogin(null);
            setScreen("auth");
            return;
          }
        }
      }

      await ensureGatewayProviderListed(app);

      // 只覆盖 endpoint + api key，不整份替换 live 配置。
      //
      // 这里以前走的是 update + switch，也就是把整份 provider 配置写到磁盘
      // 上，用户在转发期间对配置的任何修改（换 model、加 MCP server）都会被
      // 下一次写入抹掉，结束转发时又被 default 那份陈旧快照覆盖一遍。现在
      // startForwarding 会先备份 live 里现有的 endpoint + key，再只改这两个
      // 字段；结束转发时只把它们还原回去。
      //
      // 而且只写这一个 app：以前这里遍历 claude+codex，用户明明只想让 Claude
      // 走网关，Codex 的配置也被一起改了。
      const base = getGatewayBaseURL().replace(/\/+$/, "");
      const name = APP_DISPLAY_NAME[app];
      try {
        await providersApi.startForwarding(
          buildGatewayProvider(app),
          app,
          token,
          base,
        );
      } catch (error) {
        // 写盘失败就不能说自己在转发——标志置位放在成功之后，否则按钮显示
        // 「转发中」而磁盘上根本没配置，用户既用不了也不知道该点什么。
        console.error(`[forwarding] ${app} 配置写入失败`, error);
        toast.error(`开启转发失败：${name} 配置写入失败`);
        return;
      }
      localStorage.setItem(forwardingFlagKey(app), "1");
      toast.success(`已开启转发，${name} 配置已更新`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "开启转发失败");
    } finally {
      setFwdBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
      void queryClient.invalidateQueries({ queryKey: ["providers", app] });
    }
  }

  async function stopForwarding(app: ForwardableApp): Promise<void> {
    setFwdBusy(true);
    try {
      // 只还原 endpoint + api key。以前这里是切回 default——而 default 是很久
      // 以前一次 import 留下的快照，切过去等于把那份陈旧配置整个写回磁盘，把
      // 用户后来改的东西全抹了。现在只动这两个字段，转发期间的修改全部保留；
      // 转发前本就没配过凭据的话就直接删掉，不留网关的值。
      await providersApi.stopForwarding(app);
      localStorage.removeItem(forwardingFlagKey(app));
      toast.success(`已结束转发，${APP_DISPLAY_NAME[app]} 原有配置已还原`);
    } catch (error) {
      console.error(`[forwarding] ${app} 配置还原失败`, error);
      toast.error(error instanceof Error ? error.message : "结束转发失败");
    } finally {
      setFwdBusy(false);
      void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
      void queryClient.invalidateQueries({ queryKey: ["providers", app] });
    }
  }

  // 登出/改密码用：token 已经失效，任何还压着网关 endpoint 的 app 都得还原。
  // 正常情况下最多只有一个，这里遍历是防不变量被破坏时留下残留（上次会话崩了
  // 之类）；后端没备份时 stop_forwarding 是空操作，白调不要钱。
  async function stopForwardingEverywhere(): Promise<void> {
    for (const app of FORWARDABLE_APPS) {
      try {
        await providersApi.stopForwarding(app);
        localStorage.removeItem(forwardingFlagKey(app));
      } catch (error) {
        console.error(`[forwarding] ${app} 配置还原失败`, error);
      }
      void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
    }
  }

  async function handleToggleForwarding() {
    if (fwdBusy) return;
    if (!target) {
      toast.info(`${activeAppName} 暂不支持转发`);
      return;
    }
    if (forwarding) {
      await stopForwarding(target);
      return;
    }
    if (isActive) {
      await startForwarding(target);
      return;
    }
    // 本地说没套餐——这是全 app 唯一会真正挡住用户的判断，所以在这里跟服务端
    // 对一次账再决定。管理员在后台开的套餐不经过客户端，缓存里那份会一直停在
    // 「未开通」，不问的话人就点不动转发，而服务端其实早已放行。
    setFwdBusy(true);
    let fresh: SubscriptionRead | null = null;
    try {
      fresh = await refreshSubscription();
    } finally {
      setFwdBusy(false);
    }
    if (fresh?.subscription.active) {
      await startForwarding(target);
      return;
    }
    if (!fresh) {
      // 没问到答案。这里不能说「请先购买会员」——断网时那句话是假的，会把人
      // 推去重复下单。
      toast.error("无法确认套餐状态，请检查网络后重试");
      return;
    }
    // 服务端确认了确实没开通。未验证邮箱的话连购买屏都进不去，goToPurchase 会
    // 改道去验证屏并自己提示原因——这里就别再叠一条「请先购买会员」的 toast。
    if (login && fresh.user?.email_verified === false) {
      await goToPurchase(fresh);
      return;
    }
    toast.info("请先购买会员再开启转发");
    await goToPurchase(fresh);
  }

  // ---- auth -----------------------------------------------------------------

  function validate(): boolean {
    const next = {
      user: !username.trim(),
      mail: authMode === "register" && !email.trim(),
      pass: !password.trim(),
    };
    setErrors(next);
    return !next.user && !next.mail && !next.pass;
  }

  function handleSaveGatewayURL() {
    const trimmed = gatewayURL.trim();
    if (!trimmed) return;
    setGatewayBaseURL(trimmed); // strips trailing slashes before persisting
    const saved = getGatewayBaseURL();
    setGatewayURL(saved); // reflect the normalized value back into the field
    toast.success(`网关地址已保存：${saved}`);
  }

  async function handleSubmitAuth() {
    if (!validate()) {
      toast.error("请填写必填项");
      return;
    }
    setBusy(true);
    try {
      const common = {
        username: username.trim(),
        password,
        deviceName: navigator.platform || "local-device",
        platform: navigator.userAgent || "browser",
      };
      const result =
        authMode === "register"
          ? await registerGateway({
              ...common,
              email: email.trim(),
              inviteCode: inviteCode.trim(),
            })
          : await loginGateway(common);
      setLogin(result);
      // 新注册的邮箱还没验证：直接带去验证屏，而不是让人在账号屏自己发现
      // 那个「未验证」徽标——验证码这时候正好该发。
      const justRegistered = authMode === "register";
      setScreen(
        justRegistered && result.user.email_verified === false
          ? "verify-email"
          : "account",
      );
      // 规则 1 + 凭据就绪：确保条目在列表里，并把最新 token 写进条目数据。
      if (target) {
        await ensureGatewayProviderListed(target);
        await syncGatewayProviderEntry(target);
      }
      toast.success(justRegistered ? "注册成功，请验证邮箱" : "登录成功");
    } catch (error) {
      clearGatewayLogin();
      setLogin(null);
      // The gateway returns 401 on bad credentials, and surfaces the rest as
      // {"error":"invite_code_required"} and friends.
      const code = gatewayErrorCode(error);
      const authErrors: Record<string, string> = {
        invite_code_required: "注册需要邀请码",
        invalid_invite_code: "邀请码无效或已被使用",
        email_already_exists: "该邮箱已被注册",
        username_already_exists: "该用户名已被注册",
        invalid_email: "邮箱格式不正确",
      };
      toast.error(
        authErrors[code] ??
          (gatewayErrorStatus(error) === 401
            ? "账号或密码错误"
            : authMode === "register"
              ? "注册失败"
              : "登录失败"),
      );
    } finally {
      setBusy(false);
    }
  }

  // ---- email verification / password reset ----------------------------------

  function goToVerifyEmail() {
    setEmailCode("");
    setCodeSent(false);
    setScreen("verify-email");
  }

  async function handleSendEmailCode() {
    if (busy || codeCooldown > 0) return;
    setBusy(true);
    try {
      await sendEmailCode();
      setCodeSent(true);
      setCodeCooldown(SEND_CODE_COOLDOWN_SECONDS);
      toast.success("验证码已发送，10 分钟内有效");
    } catch (error) {
      // 已经验证过了（多半是在另一台设备上验的）：把本地这份过期的状态更新掉，
      // 直接回账号屏，而不是让人对着一个永远发不出去的按钮点。
      if (gatewayErrorCode(error) === "email_already_verified") {
        markEmailVerified();
        toast.success("邮箱已验证");
        setScreen("account");
        return;
      }
      // 429 也进入冷却：服务端已经拒过一次，本地不倒计时的话下一次点击必然再被拒。
      if (gatewayErrorCode(error) === "code_send_cooldown") {
        setCodeCooldown(SEND_CODE_COOLDOWN_SECONDS);
      }
      toast.error(emailErrorMessage(error, "发送失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  // 把本地缓存的 profile 标记为已验证。login 是 localStorage 里的缓存，
  // 不同步更新的话账号屏会一直显示「未验证」直到重新登录。
  function markEmailVerified() {
    setLogin((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        user: { ...prev.user, email_verified: true },
      };
      saveGatewayLogin(next);
      return next;
    });
  }

  async function handleVerifyEmail() {
    if (busy) return;
    if (!/^\d{6}$/.test(emailCode.trim())) {
      toast.error("请输入 6 位验证码");
      return;
    }
    setBusy(true);
    try {
      await verifyEmail(emailCode);
      markEmailVerified();
      setEmailCode("");
      setScreen("account");
      toast.success("邮箱验证成功");
    } catch (error) {
      toast.error(emailErrorMessage(error, "验证失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  function goToForgotPassword() {
    // 登录屏填了账号的话大概率也记得邮箱，但这里要的是邮箱，不预填用户名。
    setResetCode("");
    setResetPasswordInput("");
    setResetRequested(false);
    setScreen("forgot-password");
  }

  async function handleForgotPassword() {
    if (busy) return;
    if (!resetEmail.trim()) {
      toast.error("请输入邮箱");
      return;
    }
    setBusy(true);
    try {
      await forgotPassword(resetEmail);
      setResetRequested(true);
      setCodeCooldown(SEND_CODE_COOLDOWN_SECONDS);
      // 服务端对存在和不存在的邮箱回同一个 202，这里也必须只说「如果已注册」——
      // 说成「已发送」就等于确认了这个邮箱有账号，把防枚举白做了。
      toast.success("若该邮箱已注册，验证码已发送");
    } catch (error) {
      toast.error(emailErrorMessage(error, "发送失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword() {
    if (busy) return;
    if (!/^\d{6}$/.test(resetCode.trim())) {
      toast.error("请输入 6 位验证码");
      return;
    }
    if (resetPasswordInput.length < 8) {
      toast.error("新密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      await resetPassword({
        email: resetEmail,
        code: resetCode,
        newPassword: resetPasswordInput,
      });
      // 重置会在服务端吊销该账号的所有会话（包括本机这份，如果就是同一个人）。
      // 本地凭据留着只会在下次请求时莫名 401，不如现在就清干净回登录屏。
      // 供应商条目里那份 token 也一起清掉：它已经是死的，留着只会让
      // Claude Code 一直 401——和登出时不留凭据是同一个理由。
      if (login) {
        await stopForwardingEverywhere();
        await removeGatewayProvider();
      }
      clearGatewayLogin();
      clearGatewayUsageCache();
      setLogin(null);
      setUsage(null);
      setUsageFetchedAt(null);
      setResetCode("");
      setResetPasswordInput("");
      setResetRequested(false);
      setPassword("");
      setAuthMode("login");
      setScreen("auth");
      toast.success("密码已重置，请用新密码登录");
    } catch (error) {
      toast.error(emailErrorMessage(error, "重置失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await stopForwardingEverywhere();
    await removeGatewayProvider();
    // Kill the session server-side too — with non-expiring tokens, a logout
    // that only clears localStorage would leave live credentials behind.
    // Best-effort: an offline logout must still succeed locally.
    try {
      await revokeGatewayToken();
    } catch {
      /* offline or already revoked */
    }
    clearGatewayLogin();
    clearGatewayUsageCache();
    setUsage(null);
    setUsageFetchedAt(null);
    setLogin(null);
    setScreen("auth");
    setAuthMode("login");
    setPassword("");
    setInviteCode("");
    setErrors({});
    toast.success("已登出");
  }

  async function handleRefreshToken() {
    setRefreshBusy(true);
    try {
      await refreshGatewayToken();
      // 刷新即轮换，旧 token 全部作废。用标准 update 同步条目：live 仅在
      // 该条目正被启用时随之更新（转发 + 启用的合取由列表守卫保证）。
      if (target) await syncGatewayProviderEntry(target);
      toast.success("Auth Token 已刷新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setRefreshBusy(false);
    }
  }

  // ---- subscription refresh -------------------------------------------------

  // 从服务端重读订阅并写回缓存，返回读到的内容（读失败返回 null）。
  //
  // login 里的 subscription 是登录那一刻的快照，之后只有支付成功才会更新。
  // 管理员在后台给账号开套餐（POST /admin/subscriptions/activate）不经过客户
  // 端，所以本地会一直停在「未开通」——服务端早就放行了，用户却被前端自己的
  // 陈旧状态挡在门外。凡是要拿 isActive 做拦截的地方，先调这个。
  //
  // 返回值而不是只 setLogin：setLogin 之后本次闭包里的 isActive 仍是旧值，
  // 调用方必须看返回的这一份才能立刻做判断。
  //
  // 401 先换 token 再重试一次，和用量刷新那边同一套自愈逻辑：token 在另一台
  // 设备上被轮换掉是常态，不重试的话会把「登录过期」误判成「没有套餐」。
  async function refreshSubscription(): Promise<SubscriptionRead | null> {
    const read = async (): Promise<SubscriptionRead> => {
      const res = await fetchGatewaySubscription();
      // The profile rides along so a verification that happened elsewhere (or
      // through a password reset) replaces the stale cached copy.
      setLogin((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          subscription: res.subscription,
          user: res.user ?? prev.user,
        };
        saveGatewayLogin(next);
        return next;
      });
      return res;
    };
    try {
      return await read();
    } catch (error) {
      if (gatewayErrorStatus(error) !== 401) {
        return null;
      }
      try {
        await refreshGatewayToken();
        return await read();
      } catch {
        return null;
      }
    }
  }

  // ---- purchase -------------------------------------------------------------

  async function onActivated() {
    await refreshSubscription();
  }
  onActivatedRef.current = onActivated;

  // 未验证邮箱不能下单（服务端返回 403 email_not_verified）。这里先拦一道，
  // 让人直接去验证屏，而不是走完选套餐、选月数最后在支付前被打回来。
  //
  // 进购买屏前先跟服务端对一次账：本地显示未开通、实际上管理员已经开好了的
  // 话，购买屏的「当前套餐」提示块（条件是 isActive）根本不会渲染，用户看不
  // 到任何已有套餐的线索，一路点下去会开出一张真实的微信订单——重复付钱。
  // 这一次刷新同时把 emailVerified 也校准了，所以放在验证拦截之前。
  // `known` 是调用方刚读到的订阅（读失败则为 null），传进来就不再重复请求；
  // 省略则在这里读一次。
  async function goToPurchase(
    known?: SubscriptionRead | null,
    nextIntent: PurchaseIntent = "subscription",
  ) {
    // 版本太老时服务端会拒单/算错账，进购买屏只会让人走到最后一步才失败。
    // UI 上已经把入口禁掉了，这里是兜底 —— goToPurchase 还有别的调用点
    // （比如登录后发现没订阅时自动跳转）。
    if (upgradeRequired) {
      toast.error("当前版本过旧，请更新后再购买");
      return;
    }
    let read = known;
    if (read === undefined && login) {
      setBusy(true);
      try {
        read = await refreshSubscription();
      } finally {
        setBusy(false);
      }
    }
    // 读失败（null）时沿用缓存里的判断：购买本身有服务端兜底（未验证会被 403
    // 打回并改道验证屏），不该因为一次网络抖动就打不开购买屏。
    const verified = read?.user
      ? read.user.email_verified !== false
      : emailVerified;
    if (login && !verified) {
      toast.info("购买前请先验证邮箱");
      goToVerifyEmail();
      return;
    }
    setSelectedTier(null);
    setSelectedPeriod(DEFAULT_PERIOD);
    setCheckout(null);
    setQuoteError(null);
    setSettled(null);
    // 意图不粘住上一次的选择：加量包是少数意图，下一次来换档的人不看提示
    // 就点下去会买错东西。只有从「再买一个加量包」进来时才预置成 extra。
    setIntent(nextIntent);
    setScreen("purchase");
  }

  // 兑换码。服务端做归一化和全部校验，这里只负责把错误码翻成人话 ——
  // 尤其是「不属于当前账号」：一个人可能有好几个账号，笼统说「无效」会让他
  // 反复重试同一个正确的码。
  async function handleRedeemPromo() {
    const code = redeemInput.trim();
    if (!code) {
      toast.error("请输入兑换码");
      return;
    }
    setRedeemBusy(true);
    try {
      await redeemPromoCode(code);
      await onActivated();
      setRedeemInput("");
      setScreen("account");
      toast.success("兑换成功，套餐已开通");
    } catch (error) {
      const messages: Record<string, string> = {
        promo_code_not_found: "兑换码无效",
        promo_code_not_yours: "此兑换码不属于当前账号",
        promo_code_already_redeemed: "此兑换码已被使用",
        promo_code_required: "请输入兑换码",
        email_not_verified: "兑换前请先验证邮箱",
      };
      const code = gatewayErrorCode(error);
      if (code === "email_not_verified") {
        toast.info(messages[code]);
        goToVerifyEmail();
        return;
      }
      toast.error(
        (code && messages[code]) ||
          (error instanceof Error ? error.message : "兑换失败"),
      );
    } finally {
      setRedeemBusy(false);
    }
  }

  // 选完档位和周期后拉报价，进结账页。
  //
  // **拉不到报价就不放行付款**：没有报价意味着客户端不知道点下去会发生什么
  // ——可能立即换档，也可能排队到下个月，而后者要到下个周期才生效。唯一的例外
  // 是老服务端（没有 quote 端点，404），那种情况下服务端本来也不会做换档判定，
  // 直接沿用旧流程下单。
  async function goToCheckout(
    planId: string,
    periodKey: string,
    priceUSD?: number,
    asExtra = false,
  ) {
    if (!login) {
      toast.error("请先登录");
      return;
    }
    setQuoteError(null);
    setBusy(true);
    try {
      // price_usd 只对加量包有意义（承载单位数：20 × N）。目录档的价格一律由
      // 服务端按 plan 行决定，多发一个金额只会让人以为客户端能议价。
      const quote = await fetchPlanQuote(
        planId,
        periodKey,
        asExtra ? priceUSD : undefined,
        asExtra,
      );
      setQuoteSupported(true);
      setCheckout({ planId, period: periodKey, priceUSD, asExtra, quote });
    } catch (error) {
      if (isPlanQuoteUnsupported(error)) {
        // 老服务端：整条换档流程都不存在，直接按旧流程下单。记下来，
        // 换档相关的 UI（意图分支、账号屏的换档入口）随之隐藏。
        setQuoteSupported(false);
        setIntent("subscription");
        setBusy(false);
        await handlePurchasePlan(planId, periodKey, priceUSD, asExtra);
        return;
      }
      if (gatewayErrorCode(error) === "email_not_verified") {
        toast.info("购买前请先验证邮箱");
        goToVerifyEmail();
        return;
      }
      setQuoteError(
        error instanceof Error ? error.message : "获取报价失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }

  /** 结账页点确认。排队要到下个周期才生效且不退现金，先弹二次确认。 */
  function handleCheckoutConfirm() {
    if (!checkout) return;
    if (checkout.quote.action === "queue") {
      setConfirmQueue(true);
      return;
    }
    void handlePurchasePlan(
      checkout.planId,
      checkout.period,
      checkout.priceUSD,
      checkout.asExtra,
    );
  }

  async function handlePurchasePlan(
    planId: string,
    periodKey: string,
    priceUSD?: number,
    asExtra = false,
  ) {
    if (!login) {
      toast.error("请先登录");
      return;
    }
    if (asExtra && priceUSD === undefined) {
      toast.error(`请输入 1–${EXTRA_MAX_UNITS} 的整数单位数`);
      return;
    }
    setBusy(true);
    try {
      // One flow for dev and prod: create the order, show the QR, poll until
      // the paid callback activates the plan. In dev the gateway's fake payment
      // client auto-pays within ~100ms, so the poll effect completes the
      // purchase immediately — no separate demo path.
      //
      // price_usd 只随加量包发出（20 × 单位数）。目录档发了也会被服务端忽略，
      // 但不发才是对的：价格是服务端权威，客户端没有报价的余地。
      const order = await createPlanOrder(
        planId,
        periodKey,
        asExtra ? priceUSD : undefined,
        undefined,
        asExtra,
      );
      // 零元单：抵扣额 ≥ 新套餐价，服务端不下微信单，响应里没有 code_url。
      //
      // **判据只看 code_url，不看 order_id**：服务端对零元单是否建
      // payment_orders 记录还没最终定（llm_gateway#192 里标注了二选一），
      // 依赖 order_id 存在的话其中一种实现会挂。也不看结账页那份 quote ——
      // 用户可能在结账页停了很久，余额状态变了，以本次响应为准。
      if (!order.code_url) {
        // 刷新订阅：换档已经生效（或已排队），账号屏必须立刻反映出来。
        // 余额没有单独的刷新动作 —— 客户端目前不显示余额，成功页那个数字
        // 直接取服务端在这一单里给的 resulting_balance_micros。
        await onActivated();
        setSettled({
          action: order.action ?? checkout?.quote.action ?? "activate_now",
          targetTier: checkout?.quote.target_tier ?? planId,
          newValidUntil:
            order.new_valid_until ?? checkout?.quote.new_valid_until,
          resultingBalanceMicros:
            order.resulting_balance_micros ??
            checkout?.quote.resulting_balance_micros,
        });
        setCheckout(null);
        return;
      }
      setPending({
        orderId: order.order_id,
        codeURL: order.code_url,
        planId,
        period: periodKey,
        amountMicros: order.amount_credits,
        priceUSD: asExtra ? priceUSD : undefined,
        asExtra,
      });
    } catch (error) {
      // The server is the real gate — goToPurchase only intercepts early, and a
      // cached profile can be stale. Land the user on the verify screen rather
      // than showing a raw error code.
      if (gatewayErrorCode(error) === "email_not_verified") {
        toast.info("购买前请先验证邮箱");
        goToVerifyEmail();
        return;
      }
      toast.error(error instanceof Error ? error.message : "购买失败");
    } finally {
      setBusy(false);
    }
  }

  // Poll the pending plan order until WeChat's callback marks it paid (or we
  // time out), then activate + dismiss the QR.
  useEffect(() => {
    if (!pending) return;
    // 没有二维码就没有微信单可等（零元单）。显式守卫而不是靠「反正订单不存在
    // 所以轮询会失败」—— 那样用户会看到一串报错，最后还被超时提示告知支付
    // 未完成，而他本来就不需要支付。
    if (!pending.codeURL) return;
    let cancelled = false;
    const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
    const timer = setInterval(async () => {
      if (cancelled) return;
      try {
        const order = await getPaymentOrder(pending.orderId);
        if (order.status === "paid") {
          clearInterval(timer);
          if (cancelled) return;
          await onActivatedRef.current();
          setPending(null);
          setCheckout(null);
          setScreen("account");
          toast.success("支付成功，会员已开通");
          return;
        }
      } catch {
        // Transient poll failure; keep trying until the deadline.
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        if (cancelled) return;
        setPending(null);
        toast.error("支付未完成，已取消等待。若已扣款，会员稍后会自动生效。");
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending]);

  // ---- header copy ----------------------------------------------------------

  const headTitle =
    screen === "auth"
      ? authMode === "register"
        ? "注册 llm_gateway"
        : "登录 llm_gateway"
      : screen === "purchase"
        ? "购买套餐"
        : screen === "redeem"
          ? "使用兑换码"
          : screen === "verify-email"
            ? "验证邮箱"
            : screen === "forgot-password"
              ? "找回密码"
              : "我的账号";
  const headSub =
    screen === "auth"
      ? "登录后即可在 Claude Code 中使用"
      : screen === "purchase"
        ? "微信扫码支付，支付成功即时开通"
        : screen === "redeem"
          ? "输入兑换码即时开通，额度与现有套餐叠加"
          : screen === "verify-email"
            ? "验证后即可购买套餐"
            : screen === "forgot-password"
              ? "用注册邮箱收取验证码重设密码"
              : forwarding
                ? `转发中 · ${activeAppName} 正在走 llm_gateway`
                : "已登录 · 开启转发后即可使用";

  const inputCls =
    "w-full rounded-lg border bg-muted/40 px-3 py-2 text-sm outline-none transition focus:border-primary focus:bg-background focus:ring-2 focus:ring-primary/20";

  // ---- render ---------------------------------------------------------------

  if (!open) {
    return (
      <button
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2.5 rounded-full border border-border bg-background py-2 pl-3 pr-4 text-sm font-medium shadow-xl transition hover:-translate-y-0.5"
        onClick={() => setOpen(true)}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 text-xs font-bold text-white">
          {login ? initials(login.user.username) : "GW"}
        </span>
        <span>
          {forwarding ? "转发中" : login ? login.user.username : "llm_gateway"}
        </span>
        <span
          className={`h-2 w-2 rounded-full ${
            forwarding
              ? "bg-green-500 ring-4 ring-green-500/20"
              : "bg-muted-foreground/50"
          }`}
        />
      </button>
    );
  }

  return (
    // The app header (provider icons) is a fixed z-50 bar ~96px tall at the top;
    // the dock is z-30 (must stay below dialogs, which start at z-40), so it must
    // not grow up under that bar or the header paints over it. Reserve 8.5rem
    // (header band + top/bottom gaps) so the dock's top always clears the header.
    <div className="fixed bottom-6 right-6 z-30 flex max-h-[calc(100vh-8.5rem)] w-[384px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-sm shadow-2xl">
      {/* header — flex-none so it stays pinned; the body below scrolls */}
      <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-3.5">
        <div className="min-w-0">
          <div className="truncate font-semibold">{headTitle}</div>
          <div className="truncate text-xs text-muted-foreground">
            {headSub}
          </div>
        </div>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="收起"
          onClick={() => setOpen(false)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {/* min-h-0 lets this flex child shrink below its content so overflow-y
          actually scrolls instead of being clipped by the container */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {screen === "auth" && (
          <ScreenView key="auth">
            {/* tabs */}
            <div className="relative mb-4 grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1">
              <span
                className={`absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-md bg-background shadow-sm transition-transform duration-300 ${
                  authMode === "register" ? "translate-x-full" : "translate-x-0"
                }`}
              />
              {(["login", "register"] as AuthMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`relative z-10 rounded-md py-2 text-sm font-medium transition ${
                    authMode === m ? "text-foreground" : "text-muted-foreground"
                  }`}
                  onClick={() => {
                    setAuthMode(m);
                    setErrors({});
                  }}
                >
                  {m === "login" ? "登录" : "注册"}
                </button>
              ))}
            </div>

            <label className="mb-1 block text-xs text-muted-foreground">
              账号
            </label>
            <input
              className={`${inputCls} mb-1 ${errors.user ? "border-destructive ring-2 ring-destructive/20" : "border-border"}`}
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmitAuth()}
            />

            {authMode === "register" && (
              <>
                <label className="mb-1 mt-2 block text-xs text-muted-foreground">
                  邮箱
                </label>
                <input
                  className={`${inputCls} mb-1 ${errors.mail ? "border-destructive ring-2 ring-destructive/20" : "border-border"}`}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmitAuth()}
                />
                <label className="mb-1 mt-2 block text-xs text-muted-foreground">
                  邀请码
                </label>
                <input
                  className={`${inputCls} mb-1 border-border`}
                  placeholder="ABCDE-FGHJK"
                  autoCapitalize="characters"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmitAuth()}
                />
              </>
            )}

            <label className="mb-1 mt-2 block text-xs text-muted-foreground">
              密码
            </label>
            <div className="relative">
              <input
                className={`${inputCls} pr-10 ${errors.pass ? "border-destructive ring-2 ring-destructive/20" : "border-border"}`}
                type={showPass ? "text" : "password"}
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmitAuth()}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass((v) => !v)}
                title="显示/隐藏"
              >
                {showPass ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>

            {authMode === "login" && (
              <div className="mt-1.5 text-right">
                <button
                  type="button"
                  className="text-xs text-muted-foreground transition hover:text-foreground"
                  onClick={goToForgotPassword}
                >
                  忘记密码？
                </button>
              </div>
            )}

            <button
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
              disabled={busy}
              onClick={handleSubmitAuth}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {authMode === "register" ? "注册" : "登录"}
            </button>

            <details className="mt-3.5 border-t border-border pt-2.5">
              <summary className="cursor-pointer list-none text-xs text-muted-foreground transition hover:text-foreground">
                网关地址
              </summary>
              <div className="mt-2 flex gap-1.5">
                <input
                  className={`${inputCls} flex-1`}
                  placeholder="https://api.fwai.space"
                  value={gatewayURL}
                  onChange={(e) => setGatewayURL(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveGatewayURL()}
                />
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 text-xs transition hover:border-primary disabled:opacity-60"
                  disabled={!gatewayURL.trim()}
                  onClick={handleSaveGatewayURL}
                >
                  保存
                </button>
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                登录前先确认网关地址正确；结尾多余的斜杠会自动去除。
              </div>
            </details>
          </ScreenView>
        )}

        {screen === "account" && login && (
          <ScreenView key="account">
            {/* account card */}
            <div className="mb-3.5 flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3.5">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 text-base font-bold text-white">
                {initials(login.user.username)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {login.user.username}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">{login.user.email}</span>
                  {!emailVerified && (
                    <span className="flex-none rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                      未验证
                    </span>
                  )}
                </div>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  isActive
                    ? "bg-green-500/15 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {isActive ? planLabel(subscription?.tier) : "未开通"}
              </span>
            </div>

            {/* 订阅层和加量包分开显示。平铺的话用户分不清哪张是「我的档位」、
                哪张是临时补的量，点「换档」时不知道会换掉哪一个。 */}
            {subscription && (
              <PlanSections
                subscription={subscription}
                onSwitchPlan={
                  // 老网关不做换档判定，给个换档入口只会让人点进去买到
                  // 一份并行叠加的套餐。版本过旧同理：点进去也买不成。
                  quoteSupported === false || upgradeRequired
                    ? undefined
                    : () => void goToPurchase(undefined, "subscription")
                }
                onBuyExtra={
                  quoteSupported === false || upgradeRequired
                    ? undefined
                    : () => {
                        setExtraUnitsInput("1");
                        void goToPurchase(undefined, "extra");
                      }
                }
              />
            )}

            {/* 未验证提示。说清楚挡的是什么（下单），别只写「请验证邮箱」——
                不然人不知道为什么要验，也不知道不验会怎样。 */}
            {!emailVerified && (
              <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  邮箱尚未验证，暂时无法购买套餐
                </div>
                <button
                  type="button"
                  className="flex-none rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:brightness-105"
                  onClick={goToVerifyEmail}
                >
                  去验证
                </button>
              </div>
            )}

            {/* account usage — one total for our custom plan (5h + weekly),
                sourced from the gateway; same figure the provider footer shows */}
            {isActive && usage && (usage.five_hour || usage.seven_day) && (
              <div
                className={`mb-3.5 space-y-2.5 rounded-xl border border-border bg-muted/40 p-3 ${usageIsStale ? "opacity-70" : ""}`}
              >
                <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                  <span>用量</span>
                  {usageIsStale && usageFetchedAt && (
                    <span title="当前显示的是最近一次成功获取的数据">
                      更新于 {formatStaleAge(usageFetchedAt)}
                    </span>
                  )}
                </div>
                {usage.five_hour && (
                  <UsageBar label="5 小时" window={usage.five_hour} />
                )}
                {usage.seven_day && (
                  <UsageBar label="7 天" window={usage.seven_day} />
                )}
              </div>
            )}

            {/* forwarding toggle — 只作用于当前选中的那个 CLI */}
            <button
              className={`flex w-full items-center justify-center gap-2 rounded-lg border py-2.5 font-semibold transition disabled:opacity-60 ${
                forwarding
                  ? "border-green-500/35 bg-green-500/12 text-green-600 dark:text-green-400 hover:bg-green-500/20"
                  : "border-transparent bg-primary text-primary-foreground hover:brightness-105"
              }`}
              disabled={fwdBusy || !target}
              onClick={() => void handleToggleForwarding()}
            >
              {fwdBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plug className="h-4 w-4" />
              )}
              {!target
                ? `${activeAppName} 暂不支持转发`
                : forwarding
                  ? `结束转发（${activeAppName}）`
                  : `开启转发（${activeAppName}）`}
            </button>
            {target && (
              // 说清楚作用范围：用户要能确信别的 CLI 没被碰过。
              <p className="mt-1.5 text-center text-xs text-muted-foreground">
                只改 {activeAppName} 的配置，其它 CLI 不受影响
              </p>
            )}

            {/* 版本过旧提示。挡的只有购买 —— 上面的转发开关照常可用，说清楚
                这一点，不然人会以为整个客户端废了。 */}
            {upgradeRequired && (
              <div className="mt-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                当前版本过旧，暂时无法购买套餐。请更新到最新版本后再试 ——
                转发和其它功能不受影响。
              </div>
            )}

            {/* purchase */}
            <button
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 py-2.5 font-medium transition hover:border-border/80 hover:bg-muted disabled:opacity-60"
              disabled={busy || upgradeRequired}
              onClick={() => void goToPurchase()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShoppingBag className="h-4 w-4" />
              )}
              购买套餐
            </button>

            {/* 兑换码入口。做成次要样式：绝大多数人没有码，它不该和购买抢
                注意力，但有码的人得找得到。 */}
            <button
              className="mt-2 w-full rounded-lg py-2 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-60"
              disabled={busy}
              onClick={() => {
                setRedeemInput("");
                setScreen("redeem");
              }}
            >
              使用兑换码
            </button>

            {/* advanced */}
            <details className="mt-3.5 border-t border-border pt-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
                <ChevronDown className="h-3.5 w-3.5" />
                高级
              </summary>
              <div className="pt-1.5">
                <button
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 py-2.5 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
                  disabled={refreshBusy}
                  onClick={handleRefreshToken}
                >
                  {refreshBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  刷新 Auth Token
                </button>
                <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  重新获取访问令牌；若正在转发会同步更新已安装的配置
                </div>
              </div>
            </details>

            <div className="mt-3.5 text-center">
              <button
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-destructive"
                onClick={handleLogout}
              >
                <LogOut className="h-3.5 w-3.5" />
                登出
              </button>
            </div>
          </ScreenView>
        )}

        {screen === "redeem" && (
          <ScreenView key="redeem">
            <button
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-60"
              disabled={redeemBusy}
              onClick={() => setScreen("account")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                输入管理员发给你的兑换码。兑换后的套餐会和现有套餐叠加，额度相加。
              </p>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-center font-mono text-sm tracking-widest uppercase outline-none transition focus:border-primary"
                placeholder="ABCDE-FGHJK"
                autoFocus
                spellCheck={false}
                autoCapitalize="characters"
                value={redeemInput}
                onChange={(e) => setRedeemInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !redeemBusy) {
                    void handleRedeemPromo();
                  }
                }}
              />
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
                disabled={redeemBusy || !redeemInput.trim()}
                onClick={() => void handleRedeemPromo()}
              >
                {redeemBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                兑换
              </button>
            </div>
          </ScreenView>
        )}

        {screen === "purchase" && (
          <ScreenView key="purchase">
            <button
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-60"
              disabled={Boolean(pending)}
              onClick={() => {
                // 零元单已经结清了，返回只能回账号屏 —— 退回选择页会让人
                // 以为可以再买一次。
                if (settled) {
                  setSettled(null);
                  setScreen("account");
                  return;
                }
                // 结账页退回选择页，重新选就得重新报价 —— 留着旧 quote 会让
                // 用户按上一次的报价付这一次的款。
                if (checkout) {
                  setCheckout(null);
                  return;
                }
                // 加量包那条路径没有档位选择这一层，直接退回账号屏；
                // 订阅层则先退回档位列表。
                if (intent === "extra" || !selectedTier) {
                  setScreen("account");
                  return;
                }
                setSelectedTier(null);
              }}
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>

            {settled ? (
              // 零元单成功态。用户一分钱没付，但套餐确实变了 —— 只说
              // 「购买成功」的话他会以为没生效，所以把换成了哪一档、新到期日
              // 是哪天、还剩多少余额一并说清。
              <div className="flex flex-col items-center gap-2.5 py-1 text-center">
                <MailCheck className="h-8 w-8 text-green-500" />
                <h4 className="text-[15px] font-semibold">
                  {settled.action === "queue"
                    ? "切换已安排"
                    : "已完成，无需付款"}
                </h4>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  已用账户余额完成
                  {settled.action === "extra"
                    ? "加量包购买"
                    : settled.action === "renew"
                      ? // 续费不是换档：档位一个字都没变，变的只是到期日。
                        // 说「换档到 pro」会让刚续了 pro 的人以为自己动错了档。
                        `${planLabel(settled.targetTier)} 续费`
                      : `换档到 ${planLabel(settled.targetTier)}`}
                  ，未产生新的付款。
                </div>
                <div className="w-full rounded-xl border border-border px-3 py-2.5 text-[11px] leading-relaxed">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      {settled.action === "queue"
                        ? "切换后有效期至"
                        : "有效期至"}
                    </span>
                    <span className="font-medium">
                      {formatPlanDate(settled.newValidUntil) || "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">剩余余额</span>
                    <span className="font-medium">
                      {settled.resultingBalanceMicros === undefined
                        ? "—"
                        : formatMicrosUSD(settled.resultingBalanceMicros)}
                    </span>
                  </div>
                </div>
                <button
                  className="mt-1 w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105"
                  onClick={() => {
                    setSettled(null);
                    setScreen("account");
                  }}
                >
                  完成
                </button>
              </div>
            ) : pending ? (
              <div className="flex flex-col items-center gap-3 py-1 text-center">
                <h4 className="text-[15px] font-semibold">微信扫码支付</h4>
                <div className="text-xs text-muted-foreground">
                  {/* priceUSD 只在 asExtra 时才会被填（见 setPending），所以
                      第一个分支已经覆盖了它的全部取值。自选金额档删掉之后，
                      原来那个 `自选 $X` 分支永远走不到了，留着只会让人以为
                      客户端还有一条自报价格的下单路径。 */}
                  {pending.asExtra
                    ? `加量包 ${Math.round((pending.priceUSD ?? 0) / EXTRA_UNIT_USD)} 单位`
                    : `${planLabel(pending.planId)} 套餐`}{" "}
                  · {findPeriod(pending.period).label} ·{" "}
                  {formatMicrosUSD(pending.amountMicros)}
                </div>
                {/* 付款前再说一次这一单动的是哪一层。排队与否不在这里说 ——
                    那由服务端判定并通过 quote 的 action 表达（见 #11）。 */}
                {pending.asExtra && (
                  <div className="-mt-1.5 text-[11px] text-muted-foreground">
                    立即生效，与当前套餐额度叠加
                  </div>
                )}
                {pending.codeURL && (
                  <div className="rounded-xl border border-border bg-white p-3 shadow-md">
                    <QRCodeSVG value={pending.codeURL} size={168} />
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  等待支付…支付成功后自动开通
                </div>
                <button
                  className="text-xs text-muted-foreground underline transition hover:text-foreground"
                  onClick={() => setPending(null)}
                >
                  取消
                </button>
              </div>
            ) : checkout ? (
              <PlanCheckout
                quote={checkout.quote}
                currentValidUntil={subscription?.valid_until}
                busy={busy}
                onConfirm={handleCheckoutConfirm}
              />
            ) : intent === "subscription" && selectedTier ? (
              (() => {
                const tier = TIERS.find((t) => t.id === selectedTier);
                const price = tier?.priceUSD ?? 0;
                // 这一屏是订阅层的周期列表，周期档（1w/2w/3w）只卖给加量包。
                const options = periodsFor(false);
                // A tier switch can strand a weekly selection on a catalog
                // tier that cannot buy one; fall back rather than send the
                // server a period it will reject.
                const period = options.some((p) => p.key === selectedPeriod)
                  ? findPeriod(selectedPeriod)
                  : findPeriod(DEFAULT_PERIOD);
                const total = previewTotalUSD(price, period);
                const purchaseDisabled = busy;
                return (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {tier?.label} 套餐 · 选择购买时长
                    </div>
                    {tier && (
                      <div className="mb-2.5 rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        {tierDescription(tier)}
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {options.map((p) => {
                        const pTotal = previewTotalUSD(price, p);
                        const unit = previewUnitUSD(price, p);
                        // "省" is the discount only — a shorter term costing
                        // less is not a saving, so compare against the
                        // undiscounted price for the SAME period.
                        const save =
                          Math.round(((price * p.num) / p.den - pTotal) * 100) /
                          100;
                        const badge = periodDiscountLabel(p);
                        const sel = p.key === period.key;
                        return (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => setSelectedPeriod(p.key)}
                            className={`flex items-center justify-between rounded-xl border-[1.5px] px-3 py-2.5 text-left transition ${
                              sel
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/60"
                            }`}
                          >
                            <div>
                              <div className="text-sm font-semibold">
                                {p.label}
                                {badge && (
                                  <span className="ml-1.5 rounded bg-primary px-1 py-0.5 text-[10px] font-bold text-primary-foreground">
                                    {badge}
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                ${unit.amount}/{unit.unit} · {p.days} 天
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-[15px] font-bold">
                                ${pTotal}
                              </div>
                              {save > 0 && (
                                <div className="text-[11px] font-medium text-green-600 dark:text-green-400">
                                  省 ${save}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      disabled={purchaseDisabled}
                      onClick={() =>
                        void goToCheckout(
                          selectedTier,
                          period.key,
                          undefined,
                          false,
                        )
                      }
                      className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      {/* 这里显示的是目录价，实付要等服务端报价（抵扣后可能
                          是 $0）。所以按钮写「下一步」而不是「微信支付」——
                          金额只作为参考挂在后面。 */}
                      下一步 · 约 ${total}
                    </button>
                    {quoteError && (
                      <div className="mt-2 text-center text-[11px] font-medium text-red-500">
                        {quoteError}
                      </div>
                    )}
                  </>
                );
              })()
            ) : intent === "extra" ? (
              // 加量包路径：两个输入（买几个单位、买多久），**没有档位卡片、
              // 没有折扣角标** —— 加量包无折扣，把订阅那边的角标搬过来会让
              // 用户以为 12 个月的加量包也打 9 折。
              (() => {
                const units = parseExtraUnits(extraUnitsInput);
                const monthlyUSD = (units ?? 0) * EXTRA_UNIT_USD;
                const period = findPeriod(selectedPeriod);
                return (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      购买加量包 · 立即生效，与当前套餐额度叠加
                    </div>
                    <div className="mb-2.5 rounded-xl border-[1.5px] border-border px-3 py-2.5">
                      <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">
                          单位数（1 单位 = ${EXTRA_UNIT_USD}/月）
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={EXTRA_MAX_UNITS}
                          step={1}
                          value={extraUnitsInput}
                          onChange={(e) => setExtraUnitsInput(e.target.value)}
                          className="w-16 rounded-md border border-border bg-background px-2 py-1 text-right text-sm font-semibold outline-none focus:border-primary"
                        />
                      </label>
                      {/* 额度用相对描述，不给具体金额 —— 理由同档位卡片
                          （见 planDescription）。1 单位恒等于 $20 = 1× Starter，
                          所以 N 单位就是 N×，倍数是精确的。上面那行标签里的
                          $20 是**价格**不是额度，保留：用户得知道花多少钱。 */}
                      <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {units
                          ? `${units} 单位 = ${units}× Starter 的用量，叠加在当前套餐之上`
                          : "额度按单位线性叠加在当前套餐之上"}
                      </div>
                      {units === null && (
                        <div className="mt-1 text-[11px] font-medium text-red-500">
                          请输入 1–{EXTRA_MAX_UNITS} 的整数
                        </div>
                      )}
                    </div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      购买时长
                    </div>
                    <div className="flex flex-col gap-2">
                      {/* 周期全部开放：custom-only 的限制只作用于订阅层。 */}
                      {PERIODS.map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => setSelectedPeriod(p.key)}
                          className={`flex items-center justify-between rounded-xl border-[1.5px] px-3 py-2.5 text-left transition ${
                            p.key === period.key
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/60"
                          }`}
                        >
                          <span className="text-sm font-semibold">
                            {p.label}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {p.days} 天
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={busy || units === null}
                      onClick={() =>
                        void goToCheckout(
                          EXTRA_PLAN_ID,
                          period.key,
                          monthlyUSD,
                          true,
                        )
                      }
                      className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      下一步
                    </button>
                    {quoteError && (
                      <div className="mt-2 text-center text-[11px] font-medium text-red-500">
                        {quoteError}
                      </div>
                    )}
                  </>
                );
              })()
            ) : (
              <>
                {/* 意图分支。同一个「买套餐」动作在新模型下有两种完全不同的
                    含义，服务端靠 as_extra 区分，所以用户必须先表达意图。

                    没有订阅层时**照样要问**：加量包不再需要底下垫一个套餐
                    （服务端已取消该前置），而没有订阅层的人恰恰包括被赠送额度
                    的用户 —— 赠送的额度是 extra 角色，他们手上有量可用却一个
                    档位都没有。不问的话，这条路径在 UI 上根本走不到。

                    老网关（探测到没有 quote 端点）仍然不问：那边不认 as_extra，
                    选了加量包只会买到一份并行叠加的普通套餐。 */}
                {quoteSupported !== false && (
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    {(
                      [
                        {
                          key: "subscription" as const,
                          // 没有档位时说「更换 / 续费」是假的 —— 那一单会是
                          // activate_now，用户没有东西可换也没有东西可续。
                          // 不能叫「购买套餐」：打开这个面板的入口按钮就是
                          // 这四个字，两处同名会让人以为点错了地方。
                          title: hasActiveSubscriptionTier
                            ? "更换 / 续费套餐"
                            : "订阅套餐",
                          desc: hasActiveSubscriptionTier
                            ? "升档、续费立即生效，降档到期后生效"
                            : "按月付费，立即生效",
                        },
                        {
                          key: "extra" as const,
                          title: "购买加量包",
                          desc: hasActiveSubscriptionTier
                            ? "立即生效，额度叠加，不影响当前套餐"
                            : "立即生效，额度叠加，无需先买套餐",
                        },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={`rounded-xl border-[1.5px] px-2.5 py-2 text-left transition ${
                          intent === opt.key
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/60"
                        }`}
                        onClick={() => {
                          setIntent(opt.key);
                          setSelectedTier(null);
                          setSelectedPeriod(DEFAULT_PERIOD);
                        }}
                      >
                        <span className="block text-xs font-semibold">
                          {opt.title}
                        </span>
                        <span className="block text-[10px] leading-relaxed text-muted-foreground">
                          {opt.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  选择套餐 · 微信支付
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      disabled={busy}
                      className={`relative rounded-xl border-[1.5px] bg-background px-2 py-3 text-center transition hover:-translate-y-0.5 hover:border-primary disabled:opacity-60 ${
                        tier.id === "pro" ? "border-primary" : "border-border"
                      }`}
                      onClick={() => {
                        setSelectedTier(tier.id);
                        setSelectedPeriod(DEFAULT_PERIOD);
                      }}
                    >
                      {tier.id === "pro" && (
                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-white">
                          最受欢迎
                        </span>
                      )}
                      <div className="my-0.5 text-xl font-bold tracking-tight">
                        ${tier.priceUSD}
                      </div>
                      {/* 额度用相对描述，不给具体金额 —— 「5h $400」对用户是
                          个无从解读的数字，「20× Starter」才说明得了买哪档。 */}
                      <div className="text-[10px] leading-relaxed text-muted-foreground">
                        {tierBlurb(tier)}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </ScreenView>
        )}

        {screen === "verify-email" && login && (
          <ScreenView key="verify-email">
            <button
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => setScreen("account")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>

            <div className="mb-3.5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 p-3">
              <MailCheck className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
              <div className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                验证码将发送到{" "}
                <b className="break-all text-foreground">{login.user.email}</b>
                。没收到请查看垃圾邮件。
              </div>
            </div>

            <label className="mb-1 block text-xs text-muted-foreground">
              验证码
            </label>
            <div className="flex gap-1.5">
              <input
                className={`${inputCls} flex-1 text-center text-lg font-semibold tracking-[0.4em]`}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={emailCode}
                // 只留数字：粘贴带空格的验证码也能直接用。
                onChange={(e) =>
                  setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                onKeyDown={(e) => e.key === "Enter" && handleVerifyEmail()}
              />
              <button
                type="button"
                className="flex-none rounded-lg border border-border px-3 text-xs transition hover:border-primary disabled:opacity-60"
                disabled={busy || codeCooldown > 0}
                onClick={handleSendEmailCode}
              >
                {codeCooldown > 0
                  ? `${codeCooldown}s`
                  : codeSent
                    ? "重新发送"
                    : "发送验证码"}
              </button>
            </div>

            <button
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
              disabled={busy || emailCode.length !== 6}
              onClick={handleVerifyEmail}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              验证
            </button>

            <div className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              验证码 10 分钟内有效，最多可尝试 5 次
            </div>
          </ScreenView>
        )}

        {screen === "forgot-password" && (
          <ScreenView key="forgot-password">
            <button
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              onClick={() => setScreen(login ? "account" : "auth")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>

            <label className="mb-1 block text-xs text-muted-foreground">
              注册邮箱
            </label>
            <div className="flex gap-1.5">
              <input
                className={`${inputCls} flex-1`}
                placeholder="you@example.com"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleForgotPassword()}
              />
              <button
                type="button"
                className="flex-none rounded-lg border border-border px-3 text-xs transition hover:border-primary disabled:opacity-60"
                disabled={busy || codeCooldown > 0 || !resetEmail.trim()}
                onClick={handleForgotPassword}
              >
                {codeCooldown > 0
                  ? `${codeCooldown}s`
                  : resetRequested
                    ? "重新发送"
                    : "发送验证码"}
              </button>
            </div>

            <label className="mb-1 mt-2.5 block text-xs text-muted-foreground">
              验证码
            </label>
            <input
              className={`${inputCls} text-center text-lg font-semibold tracking-[0.4em]`}
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={resetCode}
              onChange={(e) =>
                setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              onKeyDown={(e) => e.key === "Enter" && handleResetPassword()}
            />

            <label className="mb-1 mt-2.5 block text-xs text-muted-foreground">
              新密码
            </label>
            <div className="relative">
              <input
                className={`${inputCls} pr-10`}
                type={showPass ? "text" : "password"}
                placeholder="至少 8 位"
                value={resetPasswordInput}
                onChange={(e) => setResetPasswordInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleResetPassword()}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass((v) => !v)}
                title="显示/隐藏"
              >
                {showPass ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>

            <button
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
              disabled={
                busy || resetCode.length !== 6 || resetPasswordInput.length < 8
              }
              onClick={handleResetPassword}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              重置密码
            </button>

            <div className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              重置成功后所有设备都会退出登录，需要用新密码重新登录
            </div>
          </ScreenView>
        )}
      </div>

      {/* 排队生效的换档（降档或同档续费）服务端不提供取消端点，也不退现金。
          页面上那行小字挡不住误操作，这里再拦一道，把三件事说清楚：什么时候
          生效、钱不退现金但改主意时会折成抵扣、期间当前套餐照常可用。 */}
      <ConfirmDialog
        isOpen={confirmQueue}
        title="确认排队切换套餐？"
        message={
          checkout
            ? `当前套餐到期后${
                formatPlanDate(subscription?.valid_until)
                  ? `（${formatPlanDate(subscription?.valid_until)}）`
                  : ""
              }自动切换到 ${planLabel(checkout.quote.target_tier)}。\n\n此操作不退款。之后如果改主意再换别的套餐，这笔费用会全额折算抵扣。\n\n切换前当前套餐照常可用，额度不受影响。`
            : ""
        }
        confirmText="确认切换"
        cancelText="再想想"
        onCancel={() => setConfirmQueue(false)}
        onConfirm={() => {
          setConfirmQueue(false);
          if (!checkout) return;
          void handlePurchasePlan(
            checkout.planId,
            checkout.period,
            checkout.priceUSD,
            checkout.asExtra,
          );
        }}
      />
    </div>
  );
}
