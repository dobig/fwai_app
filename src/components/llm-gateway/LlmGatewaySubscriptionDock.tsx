import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { GATEWAY_PROVIDER_ID } from "@/config/constants";
import {
  DEFAULT_DESKTOP_MODEL_ROWS,
  isPreviousDefaultRoutes,
  rowsToMeta,
} from "@/lib/claudeDesktopModels";
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
import {
  useForwardingAppsQuery,
  useForwardingQuery,
  useSettingsQuery,
} from "@/lib/query";
import {
  APP_DISPLAY_NAME,
  FORWARDABLE_APPS,
  forwardingFlagKey,
  GATEWAY_FORWARDING_BUSY_EVENT,
  GATEWAY_TOGGLE_FORWARDING_EVENT,
  isForwardable,
  type ForwardableApp,
} from "@/lib/apps";
import type { Provider } from "@/types";
import {
  clearGatewayLogin,
  GATEWAY_LOGIN_CHANGED_EVENT,
  GATEWAY_USAGE_CHANGED_EVENT,
  createPlanOrder,
  fetchPlanQuote,
  isPlanQuoteUnsupported,
  redeemPromoCode,
  fetchGatewaySubscription,
  fetchGatewayUsage,
  fetchGatewayOrganization,
  switchGatewayProject,
  saveGatewayOrgCache,
  loadGatewayOrgCache,
  clearGatewayOrgCache,
  forgotPassword,
  gatewayOAuthAccessToken,
  GatewayApiError,
  fetchPlanCatalog,
  FLEX_VENDOR,
  getGatewayBaseURL,
  getPaymentOrder,
  loadGatewayLogin,
  loginGateway,
  verifyGatewayLogin,
  refreshGatewayToken,
  resetPassword,
  revokeGatewayToken,
  saveGatewayLogin,
  saveGatewayUsageCache,
  loadGatewayUsageCache,
  loadGatewayTokens,
  planRole,
  clearGatewayUsageCache,
  registerGateway,
  sendEmailCode,
  setGatewayBaseURL,
  verifyEmail,
  type GatewayLoginChallenge,
  type GatewayLoginResult,
  type GatewayOrganization,
  type GatewayOrgProject,
  type GatewayPeriodPrice,
  type GatewayPlanCatalog,
  type GatewayPlanQuote,
  type GatewaySubscriptionStatus,
  type GatewayUsage,
  type GatewayUsageWindow,
  type GatewayUserProfile,
  type GatewayVendor,
} from "@/lib/api/llm-gateway";
import { useClientUpgradeSignal } from "@/lib/clientUpgrade";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { extractErrorMessage } from "@/utils/errorUtils";
import { PlanCheckout } from "./PlanCheckout";
import { PlanSections } from "./PlanSections";
import { ModelCapBar } from "./ModelCapBar";
import {
  foldedSummary,
  formatWeekReset,
  plansInVendorGroup,
  splitWeekGrants,
  weekGrantFooter,
  weekGrantLabel,
  type WeekFooterTone,
  type WeekGrant,
} from "./grantWeeks";
import { OrgProjectRow, ProjectPicker, currentOrgProject } from "./OrgProjects";
// 价格和陈述规则的文案一律来自服务端：周期列表取 GET /v1/plans 的成品价和
// 周期名，结账页取 quote 的 amount_due_micros 和 headline，二维码页取下单
// 响应的 amount_credits。档位描述、能不能买的原因这些句子也在目录里。
import {
  fillServerText,
  formatMicrosUSD,
  formatPlanDate,
  subscriptionLabel,
  vendorLabel,
} from "./planCatalog";
import {
  DEFAULT_PERIOD,
  periodDiscountLabel,
  periodInfo,
  periodOpenTo,
} from "./planPeriods";
import {
  bulkExtraSizes,
  extraBlockedText,
  extraForVendor,
  extraUnitRules,
  maxExtraUnits,
  nextExtraUnitsInput,
  parseExtraUnits,
  snapExtraUnits,
  stepExtraUnits,
} from "./extraPack";

type Screen =
  | "auth"
  | "account"
  | "projects"
  | "purchase"
  | "redeem"
  | "verify-email"
  | "forgot-password"
  | "login-code";
type AuthMode = "login" | "register";

// 登出里每一步外部调用最多等这么久。够一次正常的本地文件写入或一次网络往返，
// 又短到卡住时用户不会以为按钮坏了。
const LOGOUT_STEP_TIMEOUT_MS = 4000;

// 超时不抛错，只记日志：登出的每一步都是尽力而为，没有哪一步值得挡住登出本身。
async function withTimeout(
  work: Promise<unknown>,
  ms: number,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[logout] ${label} 超过 ${ms}ms，跳过`);
      resolve();
    }, ms);
  });
  try {
    await Promise.race([
      work.then(
        () => undefined,
        (error) => {
          console.error(`[logout] ${label} 失败`, error);
        },
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // 两步登录：challenge 本身失效（过期/已用掉/服务端重启）。和验证码错了不是
  // 一回事——这两种都得重新登录，不能只让人再输一遍码。
  invalid_challenge: "登录已失效，请重新登录",
  challenge_expired: "登录已超时，请重新登录",
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

// 报价 / 下单被拒时服务端写好的那句话（错误体的 message）。「需要先订阅哪一家」
// 「最多同时持有几个」「单位数可选哪些」都是规则，规则在服务端，所以客户端不
// 再按错误码自己翻译；code 只用来决定要不要跳转、要不要重拉目录。
function serverErrorMessage(error: unknown): string | null {
  if (!(error instanceof GatewayApiError)) return null;
  const message = error.body.message;
  return typeof message === "string" && message ? message : null;
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
  // 这一单动的是加量包还是订阅层。只决定二维码页要不要补一句加量包怎么
  // 生效 —— 排队与否由服务端判定并通过 quote 的 action 表达。
  asExtra?: boolean;
  // 二维码上方说买的是什么，取结账页那份报价的 summary（服务端写好的，如
  // 「换档到 Claude $200」）。老服务端没有报价时为空。
  summary?: string;
}

// 购买意图。订阅层走换档判定（服务端按档位高低决定立即生效还是排队），
// 加量包永远立即生效并叠加。两者在服务端靠 as_extra 区分，所以客户端必须
// 让用户先表达意图 —— 同一个「买套餐」动作在新模型下有两种完全不同的含义。
type PurchaseIntent = "subscription" | "extra";

// 加量包是独立 SKU：N 单位线性放大，无折扣。单价来自 GET /v1/plans 的
// extra.unit_price_micros，报价/下单只发单位数（units），钱由服务端算。
//
// plan id 就是 "extra"，与已删除的自选金额档没有任何关系。这里一度写成
// CUSTOM_TIER_ID —— #189 定义了定价公式却没写明 as_extra=true 时 plan id 填什么，
// 当时按「买家自报月价」猜到了 custom 那条路径上。能跑通纯粹是被服务端救了：
// `if body.AsExtra { planID = extraPlanID }` 第一步就把 URL 里的 id 丢弃。
// 契约已在 llm_gateway#189 的评论里写死：as_extra 时服务端强制改写为 extra，
// quote.target_tier 和 grant 的 plan_id 回读都是 "extra"。
const EXTRA_PLAN_ID = "extra";

// 转发的 app 吃哪一家的额度：Claude Code 和 Claude Desktop 走 Claude，Codex
// 走 GPT。
function vendorForApp(app: ForwardableApp): GatewayVendor {
  return app === "codex" ? "openai" : "claude";
}

// 生效的套餐里有没有能给这一家用的额度：绑定这一家的、Flex（两家通用），或者
// 绑定之前买的（也是两家通用）。只持有另一家的额度时服务端会把请求打回 402
// vendor_not_covered，转发开了也用不了。plans 为空（老服务端）时分辨不了，只看
// active。
function subscriptionCoversVendor(
  sub: GatewaySubscriptionStatus,
  vendor: string,
): boolean {
  if (!sub.active) return false;
  const live = (sub.plans ?? []).filter((p) => !p.pending);
  if (live.length === 0) return true;
  return live.some(
    (p) => !p.vendor || p.vendor === vendor || p.vendor === FLEX_VENDOR,
  );
}

// 已确定要买什么，等着结账页确认的那一单。quote 和下单参数绑在一起存，
// 免得用户在结账页停留时改了别处的选择、付款用的却是另一份报价。
interface CheckoutDraft {
  planId: string;
  period: string;
  units?: number;
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
  // 服务端写好的「买的是什么」，如「Claude $200 续费」。
  summary?: string;
  newValidUntil?: string;
  resultingBalanceMicros?: number;
}

// 周期行上的单价：「$95/月」「$5/周」。金额和单位都是服务端给的。
function perUnitLabel(price: GatewayPeriodPrice): string {
  return `${formatMicrosUSD(price.per_unit_micros)}/${price.per_unit === "week" ? "周" : "月"}`;
}

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
function formatReset(iso?: string | null): string {
  return iso ? formatWeekReset(iso) : "";
}

const FOOTER_TONE: Record<WeekFooterTone, string> = {
  muted: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "font-medium text-red-500",
};

// One account-usage window rendered as a labelled utilization bar. Turns red as
// it approaches the cap so users notice before they run out. `footer` replaces
// the "x 重置" line — the per-grant weekly bars say 刷新 / 到期 / 已用完 instead.
function UsageBar({
  label,
  window: w,
  footer,
}: {
  label: string;
  window: GatewayUsageWindow;
  footer?: { text: string; tone: WeekFooterTone };
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
      {footer ? (
        <div
          className={`mt-0.5 text-right text-[10px] ${FOOTER_TONE[footer.tone]}`}
        >
          {footer.text}
        </div>
      ) : (
        w.resets_at && (
          <div className="mt-0.5 text-right text-[10px] text-muted-foreground">
            {formatReset(w.resets_at)} 重置
          </div>
        )
      )}
    </div>
  );
}

// 一份额度这周用了多少、什么时候刷新（#79）。和总用量条同一个样子，只换标题
// 和时间那一行。
function WeekGrantBar({
  plan,
  showVendor,
}: {
  plan: WeekGrant;
  showVendor: boolean;
}) {
  return (
    <UsageBar
      label={weekGrantLabel(plan, showVendor)}
      window={{ utilization: plan.week_utilization }}
      footer={weekGrantFooter(plan)}
    />
  );
}

// Screen slides in from the right each time it mounts (keyed on screen name).
function ScreenView({
  children,
  contentRef,
}: {
  children: React.ReactNode;
  contentRef?: React.Ref<HTMLDivElement>;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  return (
    <div
      ref={contentRef}
      className={`transition-all duration-300 ease-out ${
        shown ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

interface LlmGatewaySubscriptionDockProps {
  /// 嵌在简洁模式主界面里（应用列表下面），常驻展开、不浮动、不能收起。
  /// 高级模式下仍是右下角的浮动面板。
  inline?: boolean;
}

export function LlmGatewaySubscriptionDock({
  inline = false,
}: LlmGatewaySubscriptionDockProps = {}) {
  const [openState, setOpen] = useState(
    () => localStorage.getItem(DOCK_OPEN_KEY) === "1",
  );
  // 内嵌时永远是「展开」：下面那些 setOpen(true)（要用户登录、购买时把面板
  // 弹出来）对它是空操作，读 open 的副作用照常跑。
  const open = inline || openState;
  // 内嵌时账号屏下半部分（购买 / 兑换 / 登出）是否展开。
  const [accountMoreOpen, setAccountMoreOpen] = useState(false);
  // 用量卡底部的折叠行是否展开：加量 / 赠送的周额度，和按模型的份额（如 Fable）。
  const [usageMoreOpen, setUsageMoreOpen] = useState(false);
  // 展开时把面板内容区钉在展开前的高度：多出来的条目在面板里往下滑，面板（简洁
  // 模式下是整个窗口）不跟着长高。null = 不钉。
  const [pinnedBodyHeight, setPinnedBodyHeight] = useState<number | null>(null);
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
  // 正在开/关哪个 app 的转发。主界面的卡片据此转圈，见下面的广播。
  const [fwdBusyApp, setFwdBusyApp] = useState<ForwardableApp | null>(null);
  const fwdBusy = fwdBusyApp !== null;
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [pending, setPending] = useState<PendingOrder | null>(null);
  // Two-step purchase: pick a tier, then pick the period before the QR.
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(DEFAULT_PERIOD);
  // 换档/续费还是补额度。默认订阅层 —— 大多数人要的是换档或续费，
  // 而买错方向的代价不对称：想换档买成加量包的话，旧档照常计费到期。
  const [intent, setIntent] = useState<PurchaseIntent>("subscription");
  // 买给哪一家。购买流程的第一步，只在目录列了厂商（服务端按厂商卖）时才问；
  // 老服务端没有这一步。
  const [vendor, setVendor] = useState<string | null>(null);
  // 加量包买几个单位。
  const [extraUnitsInput, setExtraUnitsInput] = useState("1");
  // 结账页。选完档位和周期后拉一次 quote，把抵扣额/新到期日/剩余余额/实付
  // 四个数字摆给用户看，再让他付款。**只在点「下一步」时拉** —— 每改一次
  // 选项就拉一次会让网络慢的用户看到数字闪烁。
  const [checkout, setCheckout] = useState<CheckoutDraft | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // 购买屏上的全部价格（GET /v1/plans）。拿不到就不显示价格、不让往下点，
  // 而不是退回本地算 —— 本地那份价目表正是这次删掉的东西。
  //
  // 加量包的规则也在这里（extra 块）：能买多大、这个用户能不能买、有没有
  // 商务价。eligibility 跟着用户状态走（刚买了一个加量包，上限就近了一步），
  // 所以每次进购买屏都重拉，见 loadCatalog。
  const [catalog, setCatalog] = useState<GatewayPlanCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
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
  // 两步登录：密码那条腿通过后拿到的 challenge，以及第二条腿要输的验证码。
  // challenge 只存在内存里 —— 它是一次登录中途的状态，不是凭据，写进
  // localStorage 只会让一个过期的 challenge 在下次开应用时诈尸。
  const [loginChallenge, setLoginChallenge] =
    useState<GatewayLoginChallenge | null>(null);
  const [loginCode, setLoginCode] = useState("");
  // 别处（应用设置页）改了登录信息时，面板跟着读一次，不然缓存里的资料会和
  // 设置页显示的不一致。
  useEffect(() => {
    const sync = () => setLogin(loadGatewayLogin());
    window.addEventListener(GATEWAY_LOGIN_CHANGED_EVENT, sync);
    return () => window.removeEventListener(GATEWAY_LOGIN_CHANGED_EVENT, sync);
  }, []);

  // 登出进行中：挡住连点。以前一次登出卡住时用户会连点好几下，每一下都去
  // 作废同一个 token，服务端日志里就是一串 401。
  const [loggingOut, setLoggingOut] = useState(false);
  // 换屏时把滚动位置归零。ScreenView 的入场动画（translate-x-4 → 0）会让浏览器
  // 为了「把动画中的元素滚进视野」自己滚一小段，残留下来就是新屏一进来顶部就
  // 少了一截 —— 验证登录屏上被切掉的正是「返回登录」，而那是这屏唯一的退路。
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [screen]);
  // 钉住的高度是账号屏量的，离开账号屏或收起面板就作废；折叠区跟着收起，
  // 回来时从折叠的样子重新量。
  useEffect(() => {
    setUsageMoreOpen(false);
    setPinnedBodyHeight(null);
  }, [screen, open]);
  const toggleUsageMore = () => {
    if (usageMoreOpen) {
      setUsageMoreOpen(false);
      setPinnedBodyHeight(null);
      return;
    }
    setPinnedBodyHeight(bodyRef.current?.offsetHeight || null);
    setUsageMoreOpen(true);
  };
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
  // 简洁模式（默认）下转发开关在主界面的卡片上，面板只管账号；不止一个 app
  // 可能同时在转发，所以面板上说的是「哪些」而不是「当前这个」。
  const { data: settingsData } = useSettingsQuery();
  const advancedMode = settingsData?.advancedMode ?? false;
  const forwardingApps = useForwardingAppsQuery();
  const anyForwarding = advancedMode ? forwarding : forwardingApps.length > 0;

  const subscription = login?.subscription;
  const isActive = Boolean(subscription?.active);
  // 用户持有的套餐列表（含待生效的）。服务端已排好：Flex 在最前，其余先到期
  // 的在前。老服务端不返回这个字段，取空数组，
  // 展示逻辑会退回单套餐那一行。
  const planList = subscription?.plans ?? [];
  // 这一单发给服务端的厂商：选了，而且目录里有这一家。目录不列厂商（老服务端）
  // 时是 undefined，请求体里也就不带 —— 从转发那边预选进来的也一样。
  const catalogVendors = catalog?.vendors ?? [];
  const purchaseVendor =
    vendor && catalogVendors.includes(vendor) ? vendor : undefined;
  // 购买屏里这一家的显示名，取目录的 vendor_details。老服务端下没有厂商。
  const purchaseVendorName = purchaseVendor
    ? vendorLabel(purchaseVendor, catalog?.vendor_details)
    : undefined;
  const vendorPrefix = purchaseVendorName ? `${purchaseVendorName} ` : "";
  // 意图卡片、加量包横幅上的句子：服务端按这个用户、这一家此刻的状态写好的
  // （有没有档位决定说「更换 / 续费」还是「订阅」，能不能买加量包、为什么不能）。
  // 这些判断曾经在客户端做，但「赠送额度算不算」「admin 发的档位算不算」本地
  // 判断不准，说法也随规则变，所以整句交给服务端。
  const vendorCopy = purchaseVendor
    ? catalog?.copy?.by_vendor?.[purchaseVendor]
    : undefined;
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
  // 后台定时刷新（GatewayUsagePoller）写了新用量时跟着换上。
  useEffect(() => {
    const sync = () => {
      const cached = loadGatewayUsageCache();
      if (!cached) return;
      setUsage(cached.usage);
      setUsageFetchedAt(cached.fetchedAt);
    };
    window.addEventListener(GATEWAY_USAGE_CHANGED_EVENT, sync);
    return () => window.removeEventListener(GATEWAY_USAGE_CHANGED_EVENT, sync);
  }, []);
  // 超过 30 分钟未成功刷新即视为过时：变灰并标注时间，避免陈旧值被当成实时值。
  // 后台每 20 分钟刷新一次（USAGE_REFRESH_INTERVAL_MS），阈值要比一个周期长，
  // 否则每一轮的后半段都会变灰；变灰只该表示后台刷新失败了。
  const usageIsStale =
    usageFetchedAt != null && Date.now() - usageFetchedAt > 30 * 60 * 1000;
  // 组织与项目（GET /v1/me/organization）。null = 不是组织成员，界面和以前
  // 一模一样。从缓存起步，组织成员打开面板不会先闪一下个人账号的界面。
  const [org, setOrg] = useState<GatewayOrganization | null>(
    () => loadGatewayOrgCache()?.org ?? null,
  );
  const isOrgMember = Boolean(login && org);
  // 用量按套餐绑定的厂商分组（服务端 vendors）：Claude、GPT、通用各一组，
  // 只有用户手上有的才出现。老服务端（或升级前的缓存）没有 vendors，就是
  // 顶层那一组，不带厂商标题，和以前一样。
  //
  // 每组里的「7 天」再按份拆开（#79）：这一家的每份额度一条，订阅常显，
  // 加量 / 赠送收进折叠行。组织成员的用量按项目算，不拆；没有分份数据时
  // week 是 null，这一组还是一条「7 天」。
  const groupVendors = (usage?.vendors ?? []).map((v) => v.vendor ?? null);
  const usageGroups = (
    usage?.vendors
      ? usage.vendors.map((v) => ({
          key: v.vendor ?? "unbound",
          label: v.vendor
            ? vendorLabel(v.vendor, catalog?.vendor_details)
            : "通用",
          vendor: v.vendor ?? null,
          five_hour: v.five_hour,
          seven_day: v.seven_day,
        }))
      : usage
        ? [
            {
              key: "total",
              label: null,
              vendor: undefined,
              five_hour: usage.five_hour,
              seven_day: usage.seven_day,
            },
          ]
        : []
  )
    .filter((g) => g.five_hour || g.seven_day)
    .map((g) => ({
      ...g,
      week: isOrgMember
        ? null
        : splitWeekGrants(plansInVendorGroup(planList, g.vendor, groupVendors)),
    }));
  // 没有分组时 plans 又带厂商的话，条目标题自己写厂商（见 weekGrantLabel）。
  const showGrantVendor = !usage?.vendors && planList.some((p) => p.vendor);
  const modelCaps = usage?.model_caps ?? [];
  const usageFolded = usageGroups.flatMap((g) => g.week?.folded ?? []);
  // 折叠行上显示的数：收起来的所有条里用得最多的那个，快用完时不点开也看得到。
  const usageFoldedPeak = Math.min(
    100,
    Math.max(
      0,
      ...usageFolded.map((p) => p.week_utilization),
      ...modelCaps.flatMap((cap) =>
        [cap.five_hour, cap.seven_day].map((w) => w?.utilization ?? 0),
      ),
    ),
  );
  const usageFoldedNames = [
    ...foldedSummary(usageFolded),
    ...(modelCaps.length > 0
      ? [`${modelCaps.map((cap) => cap.label).join("、")} 份额`]
      : []),
  ];
  const currentProject = org ? currentOrgProject(org) : null;
  // 当前项目用不了：没有项目，或者项目没给这个人分额度。
  const projectBlocked =
    isOrgMember && (!currentProject || !currentProject.has_allowance);
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(
    null,
  );
  const [projectSwitchError, setProjectSwitchError] = useState<string | null>(
    null,
  );
  // 切换屏和账号屏等高：进切换屏时沿用账号屏的内容高度，列表在里面滚动，
  // 来回切换面板不跳。
  const accountContentRef = useRef<HTMLDivElement | null>(null);
  const [accountHeight, setAccountHeight] = useState<number | null>(null);

  useEffect(() => {
    localStorage.setItem(DOCK_OPEN_KEY, openState ? "1" : "0");
  }, [openState]);
  // 目录到手后把已经填着的单位数吸到合法的一档。用户在目录回来之前按老规则
  // 填了 50 的话，不吸附就会停在一个红字提示上。空的不动 —— 那是用户正在打字。
  useEffect(() => {
    const rules = extraUnitRules(catalog?.extra);
    setExtraUnitsInput((prev) =>
      prev.trim() === "" || parseExtraUnits(prev, rules) !== null
        ? prev
        : String(snapExtraUnits(Number(prev), rules)),
    );
  }, [catalog]);

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
          await syncGatewayEntries();
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

  // 组织信息和用量同一个时机刷新：面板开在账号屏时。切换项目成功后回到
  // 账号屏，也就顺带重读了一次最新的百分比。
  useEffect(() => {
    if (!open || screen !== "account" || !login) return;
    void reloadOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, screen, login]);

  // 套餐也同一个时机重读：每份额度本周用了多少（week_utilization）随请求在变，
  // 只靠登录时那份快照的话用量卡上分份的数字永远不动（#79）。静默：读不到就
  // 留着上一份。依赖 access_token 而不是 login —— 读回来写进 login，按 login
  // 依赖就会自己再触发一轮。
  const loginToken = login?.access_token;
  useEffect(() => {
    if (!open || screen !== "account" || !loginToken) return;
    void refreshSubscription();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, screen, loginToken]);

  // 窗口重新回到前台时也重读。当前项目存在服务端：别的设备上切了项目、管理员
  // 把人移出了项目，这边都要跟上 —— CLI 的请求不经过 app，app 收不到
  // no_project，只能靠自己来问。
  useEffect(() => {
    if (!login) return;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      void reloadOrg();
      void refreshSubscription();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login]);

  // 量账号屏内容的高度，给切换屏用。只记正数：账号屏卸载那一刻量到的 0 不算。
  useEffect(() => {
    const el = accountContentRef.current;
    if (screen !== "account" || !el) return;
    const measure = () => {
      if (el.offsetHeight > 0) setAccountHeight(el.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [screen, open, login]);

  // 面板每次打开重读一次转发状态：用户可能在供应商列表里手动切走，后端那边
  // 备份已经作废了，不重新读就会一直显示「结束转发」，点下去反而把陈旧的
  // token 盖回去。
  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({ queryKey: ["forwarding"] });
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
    if (app === "claude-desktop") {
      // Desktop 读的是自己的 3P profile，但条目形状和 Claude 一样（env 里两个
      // 键）。额外带一份模型清单：Desktop 的模型菜单按它渲染，留空的话菜单要靠
      // Desktop 自己去读 /v1/models。只放 Claude 系——直连不改写模型名。
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
        meta: {
          claudeDesktopMode: "direct",
          claudeDesktopModelRoutes: rowsToMeta(DEFAULT_DESKTOP_MODEL_ROWS),
        },
        notes: `Endpoint: ${base}/v1/messages`,
        createdAt: Date.now(),
      };
    }
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
model = "gpt-6.1-sol"
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
      const existing = providers[GATEWAY_PROVIDER_ID];
      if (!existing) {
        await providersApi.add(buildGatewayProvider(app), app, false);
        return;
      }
      // Claude App 的模型清单存在条目里，换代后老条目还停在旧模型上。用户
      // 没改过（恰好是某一代默认值）就换成当前默认；改过的不动。转发开着时
      // 跳过：转发期间 update 是整份写 live，等下次开启转发前（这里会先跑
      // 一遍）再换。
      if (
        app === "claude-desktop" &&
        isPreviousDefaultRoutes(existing.meta?.claudeDesktopModelRoutes) &&
        !(await providersApi.isForwarding(app))
      ) {
        await providersApi.update(
          {
            ...existing,
            meta: {
              ...existing.meta,
              claudeDesktopModelRoutes: rowsToMeta(DEFAULT_DESKTOP_MODEL_ROWS),
            },
          },
          app,
        );
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

  /// token 刷新后同步网关条目。
  ///
  /// 每个可转发的 app 都过一遍：各 app 的转发相互独立、可以同时开着（主界面上
  /// 一个 app 一张卡），哪个漏了，哪个就会拿着作废的 token 一直 401。
  /// `syncGatewayProviderEntry` 对没有条目或没开转发的 app 自己会早退，白调不要钱。
  async function syncGatewayEntries(): Promise<void> {
    for (const app of FORWARDABLE_APPS) {
      await syncGatewayProviderEntry(app);
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
    try {
      // Desktop 这边顺带把 deploymentMode 交还 1p：留着一个 token 已作废的
      // profile，Desktop 会一直 401，而用户在界面上看不出原因。
      await providersApi.removeManaged(GATEWAY_PROVIDER_ID, "claude-desktop");
    } catch {
      // 同样保持幂等：条目可能从来没建过。
    }
  }

  /// Desktop 只在启动时读 profile:开关动完得重启才生效,不说用户会以为没生效。
  /// 作为同一个提示框的副标题,而不是常驻在按钮下面——那句话 90% 的时间都是噪音。
  /// 比默认 2 秒长一些,这条比「已开启转发」更需要被看见。
  function desktopRestartNotice(app: ForwardableApp) {
    if (app !== "claude-desktop") return undefined;
    return {
      description: "需要重启 Claude App 才生效",
      duration: 5000,
    };
  }

  // 后端命令失败时 invoke 抛的是字符串而不是 Error，以前按 instanceof Error 取
  // message 永远落空，用户只看到一句「失败」，原因（哪个文件、什么错）全丢了。
  // 原因放在 description 里并多留一会儿，方便用户截图发过来。
  function forwardingErrorDetail(error: unknown) {
    const detail = extractErrorMessage(error);
    if (!detail) return undefined;
    return { description: detail, duration: 15000 };
  }

  // 需要用户接着操作（登录、购买、换项目）时把面板亮出来。请求可能来自托盘，
  // 那时主窗口多半藏着，只展开面板用户看不见，所以连窗口一起叫到前台。
  function revealPanel() {
    setOpen(true);
    void providersApi.showMainWindow().catch(() => {
      // 非 Tauri 环境（浏览器预览、测试）没有这个命令。
    });
  }

  // 托盘上的转发项打勾与否由后端按转发状态生成，状态变了要重建一次菜单。
  function refreshTray() {
    void providersApi.updateTrayMenu().catch(() => {
      // 同上：非 Tauri 环境没有托盘。
    });
  }

  async function startForwarding(app: ForwardableApp): Promise<void> {
    const token = gatewayOAuthAccessToken();
    // 规则 2：没登录不能开启转发。
    if (!login || !token) {
      toast.error("请先登录");
      return;
    }
    setFwdBusyApp(app);
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
            revealPanel();
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
        toast.error(
          `开启转发失败：${name} 配置写入失败`,
          forwardingErrorDetail(error),
        );
        return;
      }
      localStorage.setItem(forwardingFlagKey(app), "1");
      toast.success(
        `已开启转发，${name} 配置已更新`,
        desktopRestartNotice(app),
      );
    } catch (error) {
      toast.error("开启转发失败", forwardingErrorDetail(error));
    } finally {
      setFwdBusyApp(null);
      void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
      refreshTray();
      void queryClient.invalidateQueries({ queryKey: ["providers", app] });
    }
  }

  async function stopForwarding(app: ForwardableApp): Promise<void> {
    setFwdBusyApp(app);
    try {
      // 只还原 endpoint + api key。以前这里是切回 default——而 default 是很久
      // 以前一次 import 留下的快照，切过去等于把那份陈旧配置整个写回磁盘，把
      // 用户后来改的东西全抹了。现在只动这两个字段，转发期间的修改全部保留；
      // 转发前本就没配过凭据的话就直接删掉，不留网关的值。
      await providersApi.stopForwarding(app);
      localStorage.removeItem(forwardingFlagKey(app));
      toast.success(
        `已结束转发，${APP_DISPLAY_NAME[app]} 原有配置已还原`,
        desktopRestartNotice(app),
      );
    } catch (error) {
      console.error(`[forwarding] ${app} 配置还原失败`, error);
      toast.error("结束转发失败", forwardingErrorDetail(error));
    } finally {
      setFwdBusyApp(null);
      void queryClient.invalidateQueries({ queryKey: ["forwarding", app] });
      refreshTray();
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
      refreshTray();
    }
  }

  // app 缺省是当前 tab（高级模式下面板里的按钮）；主界面的卡片会点名。
  //
  // 凡是需要用户接着操作的分支（登录、购买、换项目）都把面板打开：从卡片点
  // 进来时面板多半是收着的，只切屏不展开，用户看到的就是点了没反应。
  async function handleToggleForwarding(app: ForwardableApp | null = target) {
    if (fwdBusy) return;
    if (!app) {
      toast.info(`${activeAppName} 暂不支持转发`);
      return;
    }
    const isOn =
      queryClient.getQueryData<boolean>(["forwarding", app]) ?? false;
    if (isOn) {
      await stopForwarding(app);
      return;
    }
    if (!login) {
      toast.info("请先登录 llm_gateway");
      setScreen("auth");
      revealPanel();
      return;
    }
    // 组织成员的 active 由服务端按当前项目算：当前项目有额度才为 true。
    // 个人用户还要看额度是不是这个 app 那一家的：只买了 Claude 的人开 Codex
    // 转发，开了也只会收到 402。组织成员的额度按项目算，不在这里按厂商拦。
    const appVendor = vendorForApp(app);
    const covered = (sub: GatewaySubscriptionStatus | undefined) =>
      Boolean(sub) &&
      (isOrgMember
        ? Boolean(sub?.active)
        : subscriptionCoversVendor(sub!, appVendor));
    if (covered(subscription)) {
      await startForwarding(app);
      return;
    }
    // 本地说没套餐——这是全 app 唯一会真正挡住用户的判断，所以在这里跟服务端
    // 对一次账再决定。管理员在后台开的套餐不经过客户端，缓存里那份会一直停在
    // 「未开通」，不问的话人就点不动转发，而服务端其实早已放行。
    setFwdBusyApp(app);
    let fresh: SubscriptionRead | null = null;
    try {
      fresh = await refreshSubscription();
    } finally {
      setFwdBusyApp(null);
    }
    if (fresh && covered(fresh.subscription)) {
      await startForwarding(app);
      return;
    }
    if (!fresh) {
      // 没问到答案。这里不能说「请先购买会员」——断网时那句话是假的，会把人
      // 推去重复下单。
      toast.error("无法确认套餐状态，请检查网络后重试");
      return;
    }
    // 服务端确认了没有额度。先看是不是组织成员：组织成员不能自己购买（下单
    // 会被 409 organization_member 打回），该做的是换项目或找管理员。缓存可能
    // 还停在「不是组织成员」，所以这里重读一次；没问到就退回看缓存。
    setFwdBusyApp(app);
    let orgNow: GatewayOrganization | null | undefined;
    try {
      orgNow = await reloadOrg();
    } finally {
      setFwdBusyApp(null);
    }
    const memberOrg = orgNow === undefined ? org : orgNow;
    if (login && memberOrg) {
      // 缓存还以为不是组织成员、于是按厂商拦下来的那一种：组织额度不分厂商。
      if (fresh.subscription.active) {
        await startForwarding(app);
        return;
      }
      revealPanel();
      promptNoProjectAllowance(memberOrg);
      return;
    }
    // 服务端确认了确实没开通。未验证邮箱的话连购买屏都进不去，goToPurchase 会
    // 改道去验证屏并自己提示原因——这里就别再叠一条「请先购买会员」的 toast。
    // 卖 Flex 的服务端停在选厂商那一步，Flex 排在最前；不卖 Flex 的老服务端
    // 直接停在这个 app 那一家上。目录还没拉过就先拉一次再定。
    const cat = catalog ?? (await loadCatalog());
    const offersFlex = Boolean(cat?.vendors?.includes(FLEX_VENDOR));
    const preset = offersFlex ? null : appVendor;
    if (login && fresh.user?.email_verified === false) {
      revealPanel();
      await goToPurchase(fresh, "subscription", preset);
      return;
    }
    const needs = offersFlex
      ? `${vendorLabel(appVendor)} 或 ${vendorLabel(FLEX_VENDOR, cat?.vendor_details)} 套餐`
      : `${vendorLabel(appVendor)} 套餐`;
    toast.info(
      fresh.subscription.active
        ? `当前套餐不含 ${vendorLabel(appVendor)} 额度，${APP_DISPLAY_NAME[app]} 需要 ${needs}`
        : "请先购买会员再开启转发",
    );
    revealPanel();
    await goToPurchase(fresh, "subscription", preset);
  }

  // 主界面卡片 → 面板。监听器只挂一次，经 ref 调最新的那份闭包（login、
  // isActive 这些每次渲染都会变）。
  const toggleForwardingRef = useRef(handleToggleForwarding);
  toggleForwardingRef.current = handleToggleForwarding;
  useEffect(() => {
    const onToggle = (e: Event) => {
      const app = (e as CustomEvent<ForwardableApp>).detail;
      if (!isForwardable(app)) return;
      // 告诉派发方「接住了」，见 requestToggleForwarding。
      e.preventDefault();
      // 没走到开/关那一步（要先登录、没套餐…）时托盘上的勾已经被系统自己
      // 翻过去了，也得按真实状态重建一次。
      void toggleForwardingRef.current(app).finally(refreshTray);
    };
    window.addEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, onToggle);
    return () =>
      window.removeEventListener(GATEWAY_TOGGLE_FORWARDING_EVENT, onToggle);
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent<ForwardableApp | null>(GATEWAY_FORWARDING_BUSY_EVENT, {
        detail: fwdBusyApp,
      }),
    );
  }, [fwdBusyApp]);

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

  // 登录成功后的公共尾巴。三条路会走到这里：单步登录、两步登录的第二条腿、
  // 注册。抽出来是因为「把 token 写进供应商条目」这一步一旦漏掉，Claude Code
  // 那边就会拿着空凭据一直 401 —— 新增一条登录路径时最容易漏的正是它。
  async function finishLogin(
    result: GatewayLoginResult,
    justRegistered: boolean,
  ) {
    setLogin(result);
    setLoginChallenge(null);
    setLoginCode("");
    setPassword("");
    // 新注册的邮箱还没验证：直接带去验证屏，而不是让人在账号屏自己发现
    // 那个「未验证」徽标——验证码这时候正好该发。
    setScreen(
      justRegistered && result.user.email_verified === false
        ? "verify-email"
        : "account",
    );
    // 规则 1 + 凭据就绪：确保条目在列表里，并把最新 token 写进条目数据。
    if (target) {
      await ensureGatewayProviderListed(target);
    }
    await syncGatewayEntries();
    toast.success(justRegistered ? "注册成功，请验证邮箱" : "登录成功");
  }

  // 两步登录的第二条腿。只发 challenge_id + 验证码：设备是服务端在密码那一步
  // 记下来的，这里要是能自报设备，从邮箱里捞到验证码的人就能把 session 换到
  // 自己机器上 —— 别为了「顺手带上」而加字段。
  async function handleVerifyLoginCode() {
    if (busy || !loginChallenge) return;
    if (!/^\d{6}$/.test(loginCode.trim())) {
      toast.error("请输入 6 位验证码");
      return;
    }
    setBusy(true);
    try {
      const result = await verifyGatewayLogin({
        challengeId: loginChallenge.challengeId,
        code: loginCode,
      });
      await finishLogin(result, false);
    } catch (error) {
      const code = gatewayErrorCode(error);
      // challenge 没了（过期/已用掉）：再输几次验证码也没用，退回登录屏重来。
      // 验证码本身错了则留在原地 —— 服务端不会因为一次手误就作废 challenge。
      if (code === "invalid_challenge" || code === "challenge_expired") {
        setLoginChallenge(null);
        setLoginCode("");
        setScreen("auth");
        toast.error(emailErrorMessage(error, "登录已失效，请重新登录"));
        return;
      }
      toast.error(emailErrorMessage(error, "验证失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  // 重新走一遍密码那条腿，让服务端重发验证码。没有单独的「重发登录码」端点，
  // 也不该有：那会变成一个不需要密码就能触发的发信入口。代价是要重新输密码，
  // 所以这里把人送回登录屏，而不是画一个点了没反应的重发按钮。
  function backToLoginFromCode() {
    setLoginChallenge(null);
    setLoginCode("");
    setScreen("auth");
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
      if (authMode === "login") {
        const outcome = await loginGateway(common);
        // 服务端要第二因子：密码是对的，验证码已经发去账号邮箱了。这不是失败，
        // 不能进 catch 那条路去清凭据、弹「账号或密码错误」。
        if (outcome.kind === "challenge") {
          setLoginChallenge(outcome);
          setLoginCode("");
          setPassword("");
          // sent=false 是服务端的重发冷却压住了新邮件，上一封仍然有效。本地也
          // 跟着倒计时，否则「重新发送」立刻可点、点了必然再被拒。
          setCodeCooldown(outcome.sent ? 0 : SEND_CODE_COOLDOWN_SECONDS);
          setScreen("login-code");
          toast.info(
            outcome.sent
              ? "已向邮箱发送验证码"
              : "刚发过验证码，请查收上一封邮件",
          );
          return;
        }
        await finishLogin(outcome, false);
        return;
      }
      const result = await registerGateway({
        ...common,
        email: email.trim(),
        inviteCode: inviteCode.trim(),
      });
      await finishLogin(result, true);
    } catch (error) {
      clearGatewayLogin();
      setLogin(null);
      // The gateway returns 401 on bad credentials, and surfaces the rest as
      // {"error":"invite_code_required"} and friends.
      const code = gatewayErrorCode(error);
      const authErrors: Record<string, string> = {
        registration_closed: "暂停新用户注册，请稍后再来",
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
      clearGatewayOrgCache();
      setLogin(null);
      setUsage(null);
      setUsageFetchedAt(null);
      setOrg(null);
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

  // 登出以本地为准：先把本机的凭据和界面清掉，再去做那些要等外部的事。
  //
  // 以前是反过来的 —— 先还原转发、删供应商条目、再请求服务端作废 token，全部
  // 做完才清本地。这几步每一步都可能卡住：revoke 是一个没有超时的 fetch，网络
  // 不通时永远不返回；Tauri 那两个命令也可能等文件锁。任何一步挂住，后面的
  // 「清本地、回登录页、提示已登出」就都不会执行，用户看到的就是点了没反应。
  //
  // 现在：
  // - 本地状态立刻清掉，登录页和「已登出」马上出现；
  // - 还原转发和删供应商条目仍然要做（token 作废后网关 endpoint 不能留在
  //   CLI 配置里），但各自有超时，超时只记日志、不挡登出；
  // - 服务端作废 token 在后台做，也有超时。失败了本地照样登出 —— 离线登出
  //   本来就该成功。
  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    // 先拿住 refresh token：下面马上就要把本地凭据清掉。
    const refreshToken = loadGatewayTokens()?.refresh_token;
    try {
      await withTimeout(
        stopForwardingEverywhere(),
        LOGOUT_STEP_TIMEOUT_MS,
        "还原转发",
      );
      await withTimeout(
        removeGatewayProvider(),
        LOGOUT_STEP_TIMEOUT_MS,
        "移除网关供应商",
      );
    } finally {
      clearGatewayLogin();
      clearGatewayUsageCache();
      clearGatewayOrgCache();
      setUsage(null);
      setUsageFetchedAt(null);
      setOrg(null);
      setLogin(null);
      setScreen("auth");
      setAuthMode("login");
      setPassword("");
      setInviteCode("");
      setErrors({});
      setLoggingOut(false);
      toast.success("已登出");
    }
    // 服务端作废放在最后、不 await：它只影响服务端那一侧，本地已经登出了。
    if (refreshToken) {
      void revokeGatewayToken({
        refreshToken,
        timeoutMs: LOGOUT_STEP_TIMEOUT_MS,
      }).catch(() => {
        /* offline or already revoked — the local logout already happened */
      });
    }
  }

  async function handleRefreshToken() {
    setRefreshBusy(true);
    try {
      await refreshGatewayToken();
      // 刷新即轮换，旧 token 全部作废。用标准 update 同步条目：live 仅在
      // 该条目正被启用时随之更新（转发 + 启用的合取由列表守卫保证）。
      await syncGatewayEntries();
      toast.success("Auth Token 已刷新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新失败");
    } finally {
      setRefreshBusy(false);
    }
  }

  // ---- organization projects ------------------------------------------------

  // 重读组织信息并写回缓存。404 = 不是组织成员（含老网关），落成 null；网络
  // 错误保留上一份 —— 不能因为一次断网就把组织成员
  // 当成个人用户、给他看「购买套餐」。401 先换 token 再试一次，同用量那边。
  // 登录过期的提示交给用量刷新去说，这里不重复弹。
  //
  // 返回读到的结果；没问到（网络错误、登录过期、期间已登出）返回 undefined，
  // 调用方据此决定要不要退回看缓存。
  async function reloadOrg(): Promise<GatewayOrganization | null | undefined> {
    const read = async () => {
      const next = await fetchGatewayOrganization();
      // 请求在路上时用户登出了：不要把上一个账号的组织写回去。
      if (!loadGatewayTokens()) return undefined;
      saveGatewayOrgCache(next);
      setOrg(next);
      return next;
    };
    try {
      return await read();
    } catch (error) {
      if (gatewayErrorStatus(error) !== 401) return undefined;
      try {
        await refreshGatewayToken();
        return await read();
      } catch {
        // 留给用量刷新提示「登录已过期」。
        return undefined;
      }
    }
  }

  // 组织成员当前项目用不了时的去处：有项目就带去切换屏，没有就只能找管理员。
  // 绝不提「购买」—— 组织成员买不了。
  function promptNoProjectAllowance(memberOrg: GatewayOrganization) {
    if (memberOrg.projects.length === 0 || !memberOrg.current_project_id) {
      toast.info("还没有加入项目，请联系组织管理员");
      setScreen("account");
      return;
    }
    // 一个有额度的项目都没有（比如组织席位到期）：切换屏里全是「无额度」，
    // 带过去也换不出额度，只能找管理员。
    if (!memberOrg.projects.some((p) => p.has_allowance)) {
      toast.info("你所在的项目都没有额度，请联系组织管理员");
      setScreen("account");
      return;
    }
    toast.info("当前项目没有额度，请切换到其他项目或联系组织管理员");
    openProjects();
  }

  // 报价 / 下单 / 兑换被 409 organization_member 打回：本地缓存还以为这是个人
  // 用户（组织成员看不到这些入口）。重读组织信息，回账号屏换成项目界面。
  function handleOrgMemberPurchaseBlocked(
    error: unknown,
    message = "组织成员的额度由组织分配，不能自己购买",
  ): boolean {
    if (gatewayErrorCode(error) !== "organization_member") return false;
    toast.info(message);
    void reloadOrg();
    setScreen("account");
    return true;
  }

  function openProjects() {
    setProjectSwitchError(null);
    setScreen("projects");
  }

  // 切换当前项目。不做乐观更新：当前项目对所有设备生效，界面只跟服务端确认
  // 过的结果走。
  async function handlePickProject(project: GatewayOrgProject) {
    if (switchingProjectId || !org) return;
    setSwitchingProjectId(project.id);
    setProjectSwitchError(null);
    try {
      let res: { current_project_id: string };
      try {
        res = await switchGatewayProject(project.id);
      } catch (error) {
        if (gatewayErrorStatus(error) !== 401) throw error;
        await refreshGatewayToken();
        res = await switchGatewayProject(project.id);
      }
      const next = { ...org, current_project_id: res.current_project_id };
      saveGatewayOrgCache(next);
      setOrg(next);
      // /v1/subscription 和 /api/oauth/usage 都按当前项目算。先把两份都换成
      // 新项目的再回账号屏：否则用量卡会顶着新项目的名字显示旧项目的数字，
      // 转发判断用的 active 也还是旧项目的。读失败不挡切换 —— 服务端已经切了。
      await Promise.allSettled([
        refreshSubscription(),
        fetchGatewayUsage().then((u) => {
          saveGatewayUsageCache(u);
          setUsage(u);
          setUsageFetchedAt(Date.now());
        }),
      ]);
      toast.success(
        project.has_allowance
          ? `已切换到「${project.name}」`
          : `已切换到「${project.name}」，但这个项目没有给你分配额度`,
      );
      setScreen("account");
    } catch (error) {
      if (gatewayErrorCode(error) === "project_forbidden") {
        // 多半是刚被移出这个项目：重拉列表，让它从列表里消失。
        setProjectSwitchError(
          `你已不在「${project.name}」这个项目里，列表已刷新`,
        );
        toast.error("切换失败：没有这个项目的权限");
        void reloadOrg();
      } else {
        setProjectSwitchError("切换失败，请检查网络后重试；当前项目没有变化");
        toast.error("切换失败，请检查网络后重试");
      }
    } finally {
      setSwitchingProjectId(null);
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
        // 打开面板、回到前台都会读一次（#79），大多数时候什么都没变。原样
        // 返回 prev，不写缓存也不广播：login 一换，用量和组织那几个 effect
        // 就会再各拉一遍。
        if (
          JSON.stringify(next.subscription) ===
            JSON.stringify(prev.subscription) &&
          JSON.stringify(next.user) === JSON.stringify(prev.user)
        ) {
          return prev;
        }
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

  // 每次进购买屏都重新拉：价格可能在两次打开之间调过。上一份目录先留着显示，
  // 新的到了再替换，免得每次进来都闪一下加载态。401 的处理同 refreshSubscription。
  // 拉到的目录也返回给调用方（失败为 null），state 要到下一次渲染才更新。
  async function loadCatalog(): Promise<GatewayPlanCatalog | null> {
    setCatalogError(false);
    try {
      const next = await fetchPlanCatalog();
      setCatalog(next);
      return next;
    } catch (error) {
      if (gatewayErrorStatus(error) === 401) {
        try {
          await refreshGatewayToken();
          const next = await fetchPlanCatalog();
          setCatalog(next);
          return next;
        } catch {
          // fall through
        }
      }
      setCatalogError(true);
      return null;
    }
  }

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
  // 省略则在这里读一次。`presetVendor` 跳过选厂商那一步（目录里没有这一家时
  // 照样会问）。
  async function goToPurchase(
    known?: SubscriptionRead | null,
    nextIntent: PurchaseIntent = "subscription",
    presetVendor: string | null = null,
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
    setVendor(presetVendor);
    setScreen("purchase");
    void loadCatalog();
  }

  // 报价 / 下单被拒时给用户看的那句话：服务端写好的 message。
  // subscription_required / extra_pack_limit 说明本地的目录过期了（比如套餐
  // 刚好到期），顺手重拉一次，让页面上的「为什么不能买」跟上。
  function purchaseErrorMessage(error: unknown): string | null {
    const code = gatewayErrorCode(error);
    if (code === "subscription_required" || code === "extra_pack_limit") {
      void loadCatalog();
    }
    return serverErrorMessage(error);
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
      const result = await redeemPromoCode(code);
      await onActivated();
      if (result.reset) {
        // 重置码改的是用量不是套餐：主动拉一次用量，让进度条马上归零，
        // 而不是等下一次打开面板。拉不到也不影响兑换结果。
        try {
          const u = await fetchGatewayUsage();
          saveGatewayUsageCache(u);
          setUsage(u);
          setUsageFetchedAt(Date.now());
        } catch {
          // 回到账号屏时会再拉一次。
        }
      }
      setRedeemInput("");
      setScreen("account");
      toast.success(
        result.reset === "reset_week"
          ? "兑换成功，本周额度和 5 小时额度已重置"
          : result.reset === "reset_5h"
            ? "兑换成功，5 小时额度已重置"
            : "兑换成功，套餐已开通",
      );
    } catch (error) {
      const messages: Record<string, string> = {
        promo_code_not_found: "兑换码无效",
        promo_code_not_yours: "此兑换码不属于当前账号",
        promo_code_already_redeemed: "此兑换码已被使用",
        promo_code_expired: "此兑换码已过期",
        promo_code_required: "请输入兑换码",
        email_not_verified: "兑换前请先验证邮箱",
      };
      const code = gatewayErrorCode(error);
      if (code === "email_not_verified") {
        toast.info(messages[code]);
        goToVerifyEmail();
        return;
      }
      if (handleOrgMemberPurchaseBlocked(error, "组织成员不能使用兑换码")) {
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

  // 400 vendor_required / invalid_vendor：手上那份目录是服务端开始按厂商卖之前
  // 拉的，或者选的那一家下架了。重拉目录、退回选厂商那一步。
  function handleVendorRejected(error: unknown): boolean {
    const code = gatewayErrorCode(error);
    if (code !== "vendor_required" && code !== "invalid_vendor") return false;
    toast.error("请重新选择要购买的套餐");
    setVendor(null);
    setSelectedTier(null);
    setCheckout(null);
    void loadCatalog();
    return true;
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
    units?: number,
    asExtra = false,
  ) {
    if (!login) {
      toast.error("请先登录");
      return;
    }
    setQuoteError(null);
    setBusy(true);
    try {
      // units 只对加量包有意义。目录档的价格一律由服务端按 plan 行决定。
      const quote = await fetchPlanQuote(
        planId,
        periodKey,
        asExtra ? units : undefined,
        asExtra,
        purchaseVendor,
      );
      setQuoteSupported(true);
      setCheckout({ planId, period: periodKey, units, asExtra, quote });
    } catch (error) {
      if (isPlanQuoteUnsupported(error)) {
        // 老服务端：整条换档流程都不存在，直接按旧流程下单。记下来，
        // 换档相关的 UI（意图分支、账号屏的换档入口）随之隐藏。
        setQuoteSupported(false);
        setIntent("subscription");
        setBusy(false);
        await handlePurchasePlan(planId, periodKey, units, asExtra);
        return;
      }
      if (gatewayErrorCode(error) === "email_not_verified") {
        toast.info("购买前请先验证邮箱");
        goToVerifyEmail();
        return;
      }
      if (handleOrgMemberPurchaseBlocked(error)) return;
      if (handleVendorRejected(error)) return;
      setQuoteError(
        purchaseErrorMessage(error) ??
          (error instanceof Error ? error.message : "获取报价失败，请重试"),
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * 结账页点确认。哪些单要二次确认（目前是排队：下个周期才生效且不退现金）
   * 由服务端决定 —— 它在报价里给了 confirm_title 就弹。
   */
  function handleCheckoutConfirm() {
    if (!checkout) return;
    if (checkout.quote.confirm_title) {
      setConfirmQueue(true);
      return;
    }
    void handlePurchasePlan(
      checkout.planId,
      checkout.period,
      checkout.units,
      checkout.asExtra,
    );
  }

  async function handlePurchasePlan(
    planId: string,
    periodKey: string,
    units?: number,
    asExtra = false,
  ) {
    if (!login) {
      toast.error("请先登录");
      return;
    }
    if (asExtra && units === undefined) {
      toast.error(catalog?.extra.units_rule_text || "加量包单位数不可用");
      return;
    }
    setBusy(true);
    try {
      // One flow for dev and prod: create the order, show the QR, poll until
      // the paid callback activates the plan. In dev the gateway's fake payment
      // client auto-pays within ~100ms, so the poll effect completes the
      // purchase immediately — no separate demo path.
      //
      // units 只随加量包发出。价格是服务端权威，客户端只说要几个单位。
      const order = await createPlanOrder(
        planId,
        periodKey,
        asExtra ? units : undefined,
        undefined,
        asExtra,
        purchaseVendor,
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
          summary: order.summary ?? checkout?.quote.summary,
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
        asExtra,
        summary: checkout?.quote.summary,
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
      if (handleOrgMemberPurchaseBlocked(error)) return;
      if (handleVendorRejected(error)) return;
      const message = purchaseErrorMessage(error);
      // 管理员在控制台暂停了接单（套餐和加量包都一样）。老服务端不带 message
      // 时的兜底。
      if (!message && gatewayErrorCode(error) === "orders_closed") {
        toast.error("暂停购买，请稍后再来");
        return;
      }
      toast.error(
        message ?? (error instanceof Error ? error.message : "购买失败"),
      );
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
      : screen === "projects"
        ? "切换项目"
        : screen === "purchase"
          ? "购买套餐"
          : screen === "redeem"
            ? "使用兑换码"
            : screen === "verify-email"
              ? "验证邮箱"
              : screen === "forgot-password"
                ? "找回密码"
                : screen === "login-code"
                  ? "验证登录"
                  : "我的账号";
  const headSub =
    screen === "auth"
      ? "登录后即可在 Claude Code 中使用"
      : screen === "projects"
        ? (org?.organization.name ?? "")
        : screen === "purchase"
          ? "微信扫码支付，支付成功即时开通"
          : screen === "redeem"
            ? "兑换套餐或重置已用额度，即时生效"
            : screen === "verify-email"
              ? "验证后即可购买套餐"
              : screen === "forgot-password"
                ? "用注册邮箱收取验证码重设密码"
                : screen === "login-code"
                  ? "输入邮箱收到的验证码完成登录"
                  : (advancedMode
                      ? forwarding
                        ? `转发中 · ${activeAppName} 正在走 llm_gateway`
                        : "已登录 · 开启转发后即可使用"
                      : anyForwarding
                        ? `转发中 · ${forwardingApps
                            .map((app) => APP_DISPLAY_NAME[app])
                            .join("、")}`
                        : "已登录 · 在主界面点应用即可开启转发") +
                    (isOrgMember && currentProject
                      ? ` · ${currentProject.name}`
                      : "");

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
          {anyForwarding
            ? "转发中"
            : login
              ? login.user.username
              : "llm_gateway"}
          {/* 组织成员：不展开也知道请求在扣哪个项目 */}
          {isOrgMember && (
            <span className="font-normal text-muted-foreground">
              {" · "}
              {currentProject ? currentProject.name : "未加入项目"}
            </span>
          )}
        </span>
        <span
          className={`h-2 w-2 rounded-full ${
            projectBlocked
              ? "bg-amber-500 ring-4 ring-amber-500/20"
              : anyForwarding
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
    <div
      className={
        inline
          ? "flex flex-col overflow-hidden rounded-xl border border-border bg-card text-sm"
          : "fixed bottom-6 right-6 z-30 flex max-h-[calc(100vh-8.5rem)] w-[384px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-sm shadow-2xl"
      }
    >
      {/* header — flex-none so it stays pinned; the body below scrolls.
          内嵌在简洁模式主界面时，账号屏不要这条标题：转发状态上面的列表已经
          写着了，「我的账号」四个字只占地方。其它屏（登录、购买…）照常显示。 */}
      {!(inline && screen === "account") && (
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            <div className="truncate font-semibold">{headTitle}</div>
            <div className="truncate text-xs text-muted-foreground">
              {headSub}
            </div>
          </div>
          {!inline && (
            <button
              className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="收起"
              onClick={() => setOpen(false)}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* min-h-0 lets this flex child shrink below its content so overflow-y
          actually scrolls instead of being clipped by the container */}
      <div
        ref={bodyRef}
        className={
          inline
            ? `p-4 ${pinnedBodyHeight ? "overflow-y-auto" : ""}`
            : "min-h-0 flex-1 overflow-y-auto p-4"
        }
        // 用量折叠区展开时钉住高度（见 toggleUsageMore）。浮动面板的 body 是
        // flex-1（basis 0），换成 basis auto 才按 height 算；仍可收缩，窗口
        // 变矮时照样受面板 max-h 约束。
        style={
          pinnedBodyHeight
            ? { height: pinnedBodyHeight, flex: "0 1 auto" }
            : undefined
        }
      >
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
          <ScreenView key="account" contentRef={accountContentRef}>
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
              {/* 组织成员的套餐名是「组织名 · 当前项目名」，不是 tier（服务端
                  暂时回 enterprise，对用户没有意义）。 */}
              {isOrgMember && org ? (
                <span
                  className="max-w-[60%] flex-none truncate rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
                  title={`${org.organization.name} · ${currentProject?.name ?? "未加入项目"}`}
                >
                  {org.organization.name} ·{" "}
                  {currentProject?.name ?? "未加入项目"}
                </span>
              ) : (
                <span className="flex flex-none flex-col items-end gap-1">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      isActive
                        ? "bg-green-500/15 text-green-600 dark:text-green-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isActive ? subscriptionLabel(subscription) : "未开通"}
                  </span>
                  {/* 老服务端不返回 plans 时，有效期只有这一个数：放在套餐名
                      下面，不单独占一行。有 plans 时每条套餐自己带到期日，
                      见 PlanSections。 */}
                  {isActive &&
                    subscription?.valid_until &&
                    !(subscription.plans ?? []).length && (
                      <span className="text-[10px] text-muted-foreground">
                        至 {formatPlanDate(subscription.valid_until)}
                      </span>
                    )}
                </span>
              )}
            </div>

            {/* 订阅层和加量包分开显示。平铺的话用户分不清哪张是「我的档位」、
                哪张是临时补的量，点「换档」时不知道会换掉哪一个。 */}
            {/* 组织成员没有个人套餐：额度来自项目，套餐、购买、兑换码一概不显示，
                界面上也就不会出现金额。 */}
            {org && <OrgProjectRow org={org} onOpen={openProjects} />}

            {!isOrgMember && subscription && (
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
            {!isOrgMember && !emailVerified && (
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
            {isOrgMember && !currentProject && (
              <div className="mb-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                还没有加入项目，请联系组织管理员。加入后这里会显示项目和用量。
              </div>
            )}
            {isOrgMember && currentProject && !currentProject.has_allowance && (
              <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {org?.projects.some((p) => p.has_allowance)
                    ? `「${currentProject.name}」这个项目没有给你分配额度，可以切换到其他项目。`
                    : "你所在的项目都没有额度，请联系组织管理员。"}
                </div>
                {org?.projects.some(
                  (p) => p.id !== currentProject.id && p.has_allowance,
                ) && (
                  <button
                    type="button"
                    className="flex-none rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:brightness-105"
                    onClick={openProjects}
                  >
                    切换项目
                  </button>
                )}
              </div>
            )}
            {/* 组织成员的 /api/oauth/usage（含按模型拆分）由服务端按当前项目算，
                同一张卡，标题带上项目名。项目没额度时上面的提示代替这张卡。 */}
            {(isOrgMember ? currentProject?.has_allowance : isActive) &&
              usage &&
              usageGroups.length > 0 && (
                <div
                  className={`mb-3.5 space-y-2.5 rounded-xl border border-border bg-muted/40 p-3 ${usageIsStale ? "opacity-70" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                    <span className="truncate">
                      {isOrgMember && currentProject
                        ? `用量 · ${currentProject.name}`
                        : "用量"}
                    </span>
                    {usageIsStale && usageFetchedAt && (
                      <span
                        className="flex-none"
                        title="当前显示的是最近一次成功获取的数据"
                      >
                        更新于 {formatStaleAge(usageFetchedAt)}
                      </span>
                    )}
                  </div>
                  {usageGroups.map((g) => (
                    <div key={g.key} className="space-y-2.5">
                      {g.label && (
                        <div className="text-[11px] font-semibold text-foreground">
                          {g.label}
                        </div>
                      )}
                      {g.five_hour && (
                        <UsageBar label="5 小时" window={g.five_hour} />
                      )}
                      {/* 「7 天」按份拆开时常显订阅层（见 splitWeekGrants），
                          其余收进卡片底部的折叠行；没有分份数据时还是一条
                          总的。 */}
                      {g.week
                        ? g.week.pinned.map((p) => (
                            <WeekGrantBar
                              key={p.grant_id}
                              plan={p}
                              showVendor={showGrantVendor}
                            />
                          ))
                        : g.seven_day && (
                            <UsageBar label="7 天" window={g.seven_day} />
                          )}
                      {usageMoreOpen &&
                        (g.week?.folded ?? []).map((p) => (
                          <WeekGrantBar
                            key={p.grant_id}
                            plan={p}
                            showVendor={showGrantVendor}
                          />
                        ))}
                    </div>
                  ))}
                  {/* 份额上限按模型族算，不属于某一个厂商分组，统一放在最后。 */}
                  {usageMoreOpen &&
                    modelCaps.flatMap((cap) => [
                      <ModelCapBar
                        key={`5h-${cap.id}`}
                        cap={cap}
                        windowKey="five_hour"
                      />,
                      <ModelCapBar
                        key={`7d-${cap.id}`}
                        cap={cap}
                        windowKey="seven_day"
                      />,
                    ])}
                  {/* 加量 / 赠送的周额度和模型份额（如 Fable）默认折叠：大多数
                      时候看订阅层就够。折叠时仍给出收起来的里面最高的那个，
                      快用完时标红，不用点开也能注意到。 */}
                  {usageFoldedNames.length > 0 && (
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 pt-0.5 text-[11px] text-muted-foreground transition hover:text-foreground"
                      aria-expanded={usageMoreOpen}
                      onClick={toggleUsageMore}
                    >
                      <span className="min-w-0">
                        {usageFoldedNames.join("、")}
                      </span>
                      <span className="flex flex-none items-center gap-1">
                        {!usageMoreOpen && (
                          <span
                            className={
                              usageFoldedPeak >= 90
                                ? "font-semibold text-red-500"
                                : "text-foreground"
                            }
                          >
                            最高 {usageFoldedPeak.toFixed(1)}%
                          </span>
                        )}
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${
                            usageMoreOpen ? "rotate-180" : ""
                          }`}
                        />
                      </span>
                    </button>
                  )}
                </div>
              )}

            {/* forwarding toggle — 只作用于当前选中的那个 CLI。简洁模式下开关
                在主界面的卡片上，这里不再重复。 */}
            {advancedMode && (
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
            )}

            {/* 购买、兑换、高级、登出这些低频操作。内嵌在简洁模式主界面时默认
                折叠，主界面只留开关和用量；浮动面板照旧全部展开。 */}
            {inline && (
              <button
                className="mt-3 flex w-full items-center justify-center gap-1 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                aria-expanded={accountMoreOpen}
                onClick={() => setAccountMoreOpen((v) => !v)}
              >
                {accountMoreOpen ? "收起" : "套餐与账号"}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    accountMoreOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
            )}
            {(!inline || accountMoreOpen) && (
              <>
                {/* 版本过旧提示。挡的只有购买 —— 上面的转发开关照常可用，说清楚
                    这一点，不然人会以为整个客户端废了。 */}
                {!isOrgMember && upgradeRequired && (
                  <div className="mt-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    当前版本过旧，暂时无法购买套餐。请更新到最新版本后再试 ——
                    转发和其它功能不受影响。
                  </div>
                )}

                {/* purchase */}
                {!isOrgMember && (
                  <>
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
                  </>
                )}

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
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-destructive disabled:opacity-60"
                    disabled={loggingOut}
                    onClick={() => void handleLogout()}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    登出
                  </button>
                </div>
              </>
            )}
          </ScreenView>
        )}

        {screen === "projects" && login && org && (
          <ScreenView key="projects">
            <div
              className="flex flex-col"
              style={accountHeight ? { height: accountHeight } : undefined}
            >
              <ProjectPicker
                org={org}
                switchingId={switchingProjectId}
                error={projectSwitchError}
                onPick={(p) => void handlePickProject(p)}
                onBack={() => setScreen("account")}
                formatReset={formatReset}
              />
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
                输入管理员发给你的兑换码。套餐码兑换后会和现有套餐叠加，额度相加；额度重置码兑换后立即清零当前已用额度。
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
                  // 选厂商是第一步，选过了就先退回那一步。
                  if (purchaseVendor) {
                    setVendor(null);
                    return;
                  }
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
                {/* 买的是什么由服务端的 summary 说（续费说「续费」、换档说
                    「换档到」—— 说错了会让刚续了 pro 的人以为自己动错了档）。 */}
                <div className="text-xs leading-relaxed text-muted-foreground">
                  已用账户余额完成
                  {settled.summary ? `「${settled.summary}」` : "购买"}
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
                  {[
                    pending.summary,
                    periodInfo(catalog?.periods, pending.period).label,
                    formatMicrosUSD(pending.amountMicros),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {/* 付款前再说一次这一单动的是哪一层。排队与否不在这里说 ——
                    那由服务端判定并通过 quote 的 action 表达（见 #11）。 */}
                {pending.asExtra && catalog?.copy?.extra_effect && (
                  <div className="-mt-1.5 text-[11px] text-muted-foreground">
                    {catalog.copy.extra_effect}
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
                vendorName={purchaseVendorName}
                busy={busy}
                onConfirm={handleCheckoutConfirm}
              />
            ) : !catalog ? (
              // 价格还没到（或拿不到）。不显示任何档位和金额 —— 没有服务端
              // 价格就没有可以显示的价格。
              <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
                {catalogError ? (
                  <>
                    <span>价格加载失败</span>
                    <button
                      type="button"
                      className="underline transition hover:text-foreground"
                      onClick={() => void loadCatalog()}
                    >
                      重试
                    </button>
                  </>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
              </div>
            ) : catalogVendors.length > 0 && !purchaseVendor ? (
              // 第一步：买给哪一家。Claude 和 GPT 是两份独立的订阅，换档、续费、
              // 加量包都只作用于选中的这一家，所以在一切之前先问。
              <>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  选择要购买的模型
                </div>
                <div className="flex flex-col gap-2">
                  {catalogVendors.map((v) => {
                    const held = planList.find(
                      (p) =>
                        planRole(p) === "subscription" &&
                        !p.pending &&
                        p.vendor === v,
                    );
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          setVendor(v);
                          // Flex 没有加量包：从「买加量包」进来选了 Flex 就改成买套餐。
                          if (v === FLEX_VENDOR) setIntent("subscription");
                          setSelectedTier(null);
                          setSelectedPeriod(DEFAULT_PERIOD);
                          setQuoteError(null);
                        }}
                        className="flex items-center justify-between rounded-xl border-[1.5px] border-border px-3 py-2.5 text-left transition hover:border-primary/60"
                      >
                        <div>
                          <div className="text-sm font-semibold">
                            {vendorLabel(v, catalog.vendor_details)}
                          </div>
                          {(() => {
                            const blurb = catalog.vendor_details?.find(
                              (d) => d.id === v,
                            )?.blurb;
                            return (
                              blurb && (
                                <div className="text-[11px] text-muted-foreground">
                                  {blurb}
                                </div>
                              )
                            );
                          })()}
                        </div>
                        {/* 已经有这一家的档位就说出来：点进去是换档 / 续费，
                            不是再开一份。 */}
                        {held && (
                          <span className="flex-none text-[11px] text-muted-foreground">
                            当前 {held.label || held.tier}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {catalog.copy?.vendor_note && (
                  <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {catalog.copy.vendor_note}
                  </div>
                )}
              </>
            ) : intent === "subscription" && selectedTier ? (
              (() => {
                const tier = catalog.plans.find((p) => p.id === selectedTier);
                // 这一屏的每一个数字都是服务端给的成品价。服务端只列这一档
                // 卖的周期，周付档（只卖给加量包）本来就不在里面；这一家买不了
                // 的周期（Claude 只卖 1 个月）按 periods[].vendors 再滤掉。
                const options = (tier?.prices ?? []).filter((p) =>
                  periodOpenTo(catalog.periods, p.period, purchaseVendor),
                );
                // A tier switch can strand a weekly selection on a catalog
                // tier that cannot buy one; fall back rather than send the
                // server a period it will reject.
                const selected =
                  options.find((p) => p.period === selectedPeriod) ??
                  options.find((p) => p.period === DEFAULT_PERIOD) ??
                  options[0];
                const purchaseDisabled = busy || !selected;
                return (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {vendorPrefix}
                      {tier?.name} 套餐 · 选择购买时长
                    </div>
                    {/* 「适合谁」「几倍 Starter」是服务端写的 description。 */}
                    {tier?.description && (
                      <div className="mb-2.5 rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        {tier.description}
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {options.map((price) => {
                        const p = periodInfo(catalog.periods, price.period);
                        const badge = periodDiscountLabel(
                          catalog.periods.find((x) => x.key === price.period)
                            ?.discount_bps,
                        );
                        const sel = price.period === selected?.period;
                        return (
                          <button
                            key={price.period}
                            type="button"
                            onClick={() => setSelectedPeriod(price.period)}
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
                                {perUnitLabel(price)}
                                {p.days !== undefined && ` · ${p.days} 天`}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-[15px] font-bold">
                                {formatMicrosUSD(price.charge_micros)}
                              </div>
                              {price.savings_micros > 0 && (
                                <div className="text-[11px] font-medium text-green-600 dark:text-green-400">
                                  省 {formatMicrosUSD(price.savings_micros)}
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
                        selected &&
                        void goToCheckout(
                          selectedTier,
                          selected.period,
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
                      下一步
                      {selected &&
                        ` · 约 ${formatMicrosUSD(selected.charge_micros)}`}
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
              // 没有期限折扣角标** —— 加量包不吃 6/12 个月的折扣，把订阅那边
              // 的角标搬过来会让用户以为 12 个月的加量包也打 9 折。
              (() => {
                const extra = extraForVendor(catalog.extra, purchaseVendor);
                const rules = extraUnitRules(extra);
                const units = parseExtraUnits(extraUnitsInput, rules);
                // Claude 的加量包最长 1 个月，GPT 不限 —— 同订阅那边一样按
                // periods[].vendors 滤。
                const options = extra.prices.filter((p) =>
                  periodOpenTo(catalog.periods, p.period, purchaseVendor),
                );
                const period =
                  options.find((p) => p.period === selectedPeriod)?.period ??
                  DEFAULT_PERIOD;
                // 不能买的原因（没有付费套餐 / 加量包已到上限），服务端写好的
                // 句子。目录里没有 eligibility 时是 null，不拦 —— 报价那一步
                // 服务端会再说一次。
                const blocked = extraBlockedText(
                  extra,
                  catalog.copy,
                  purchaseVendor,
                );
                const noPlan =
                  extra.eligibility?.reason === "subscription_required";
                // 20 以上可选的那几档，连同 20 本身做成快捷选项：输入框里一格
                // 一格点到 80 太累。
                const bulk = bulkExtraSizes(rules);
                const quickSizes = bulk.length > 0 ? [rules.step, ...bulk] : [];
                return (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      购买{purchaseVendorName && ` ${purchaseVendorName} `}
                      加量包
                      {catalog.copy?.extra_effect &&
                        ` · ${catalog.copy.extra_effect}`}
                    </div>
                    {blocked && (
                      <div className="mb-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                        <div className="font-medium">{blocked}</div>
                        {noPlan && (
                          <button
                            type="button"
                            className="mt-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white transition hover:brightness-105"
                            onClick={() => {
                              setIntent("subscription");
                              setSelectedTier(null);
                              setSelectedPeriod(DEFAULT_PERIOD);
                            }}
                          >
                            去订阅套餐
                          </button>
                        )}
                      </div>
                    )}
                    <div className="mb-2.5 rounded-xl border-[1.5px] border-border px-3 py-2.5">
                      <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">
                          单位数（1 单位 ={" "}
                          {formatMicrosUSD(catalog.extra.unit_price_micros)}
                          /月）
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={maxExtraUnits(rules)}
                          step={1}
                          value={extraUnitsInput}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setExtraUnitsInput((prev) =>
                              nextExtraUnitsInput(prev, raw, rules),
                            );
                          }}
                          onKeyDown={(e) => {
                            // 方向键在合法单位数之间走：20 往上是 40。
                            if (e.key !== "ArrowUp" && e.key !== "ArrowDown")
                              return;
                            e.preventDefault();
                            setExtraUnitsInput((prev) =>
                              String(
                                stepExtraUnits(
                                  Number(prev) || 1,
                                  e.key === "ArrowUp" ? 1 : -1,
                                  rules,
                                ),
                              ),
                            );
                          }}
                          // 打字的中途不吸附（打「40」必然经过「4」），失焦时
                          // 再把 25 这类买不到的数吸到最近的一档。
                          onBlur={() =>
                            setExtraUnitsInput((prev) =>
                              String(snapExtraUnits(Number(prev), rules)),
                            )
                          }
                          className="w-16 rounded-md border border-border bg-background px-2 py-1 text-right text-sm font-semibold outline-none focus:border-primary"
                        />
                      </label>
                      {quickSizes.length > 0 && (
                        <div className="mt-2 flex items-center gap-1.5">
                          {quickSizes.map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setExtraUnitsInput(String(n))}
                              className={`flex-1 rounded-md border px-1 py-1 text-xs font-semibold transition ${
                                units === n
                                  ? "border-primary bg-primary/5"
                                  : "border-border hover:border-primary/60"
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* 额度用相对描述，不给具体金额 —— 「N 单位 = N×
                          Starter」这句由服务端写（units_text，{units} 由这里
                          填），单位数规则那句也是（units_rule_text）。上面那行
                          标签里的单价是**价格**不是额度，保留：用户得知道花
                          多少钱。 */}
                      {units !== null && catalog.extra.units_text && (
                        <div className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                          {fillServerText(catalog.extra.units_text, { units })}
                        </div>
                      )}
                      {catalog.extra.units_rule_text &&
                        (units === null ? (
                          <div className="mt-1 text-[11px] font-medium text-red-500">
                            {catalog.extra.units_rule_text}
                          </div>
                        ) : (
                          bulk.length > 0 && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {catalog.extra.units_rule_text}
                            </div>
                          )
                        ))}
                    </div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      购买时长
                    </div>
                    <div className="flex flex-col gap-2">
                      {/* 周付只对加量包开放，订阅层不卖。每行的价格是目录里
                          「一个单位」的成品价，不乘单位数 —— N 单位的实付以
                          结账页的报价为准，客户端不算钱。单位数不合法时不显示
                          价格，免得像是在给一个买不到的数报价。 */}
                      {options.map((listPrice) => {
                        const p = periodInfo(catalog.periods, listPrice.period);
                        const price = units === null ? null : listPrice;
                        return (
                          <button
                            key={listPrice.period}
                            type="button"
                            onClick={() => setSelectedPeriod(listPrice.period)}
                            className={`flex items-center justify-between rounded-xl border-[1.5px] px-3 py-2.5 text-left transition ${
                              listPrice.period === period
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/60"
                            }`}
                          >
                            <div>
                              <div className="text-sm font-semibold">
                                {p.label}
                              </div>
                              {price && (
                                <div className="text-[11px] text-muted-foreground">
                                  {p.days !== undefined && `${p.days} 天`}
                                </div>
                              )}
                            </div>
                            {price ? (
                              <div className="text-right">
                                <div className="text-[15px] font-bold">
                                  {formatMicrosUSD(price.charge_micros)}
                                  <span className="text-[11px] font-normal text-muted-foreground">
                                    /单位
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {p.days !== undefined && `${p.days} 天`}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      disabled={busy || units === null || blocked !== null}
                      onClick={() =>
                        units !== null &&
                        void goToCheckout(EXTRA_PLAN_ID, period, units, true)
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

                    没有订阅层时也照样问，但加量包那一格要说实话：服务端现在
                    要求先有生效的付费套餐才能买加量包（赠送额度不算，见
                    llm_gateway#325）。不把入口藏掉，点进去能看到原因和「去订阅
                    套餐」—— 藏掉的话，被赠送额度的用户不知道加量包为什么没了。
                    两张卡片上的字（「更换 / 续费」还是「订阅」、加量包为什么
                    买不了）都是服务端按这个用户的状态写好的，见 vendorCopy。

                    老网关（探测到没有 quote 端点）仍然不问：那边不认 as_extra，
                    选了加量包只会买到一份并行叠加的普通套餐。 */}
                {/* Flex 没有加量包，只剩一张卡片也就不用问了。 */}
                {quoteSupported !== false && purchaseVendor !== FLEX_VENDOR && (
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    {(
                      [
                        {
                          key: "subscription" as const,
                          // 服务端没给标题（老网关）时只说「套餐」：说「更换
                          // / 续费」可能是假的，那一单也许是 activate_now。
                          title: vendorCopy?.subscription_title || "套餐",
                          desc: vendorCopy?.subscription_hint ?? "",
                        },
                        {
                          key: "extra" as const,
                          title: "购买加量包",
                          desc: vendorCopy?.extra_hint ?? "",
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
                  {purchaseVendorName && `${purchaseVendorName} · `}
                  选择套餐 · 微信支付
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {catalog.plans.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      disabled={busy}
                      className={`relative rounded-xl border-[1.5px] bg-background px-2 py-3 text-center transition hover:-translate-y-0.5 hover:border-primary disabled:opacity-60 ${
                        tier.badge ? "border-primary" : "border-border"
                      }`}
                      onClick={() => {
                        setSelectedTier(tier.id);
                        setSelectedPeriod(DEFAULT_PERIOD);
                      }}
                    >
                      {/* 角标（「最受欢迎」）推哪一档、写什么都是服务端的事。 */}
                      {tier.badge && (
                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-white">
                          {tier.badge}
                        </span>
                      )}
                      <div className="my-0.5 text-xl font-bold tracking-tight">
                        {formatMicrosUSD(tier.price_usd_micros)}
                      </div>
                      {/* 额度用相对描述，不给具体金额 —— 「5h $400」对用户是
                          个无从解读的数字，「10× Starter」才说明得了买哪档。
                          那句话（blurb）由服务端按当前的额度规则写。 */}
                      {tier.blurb && (
                        <div className="text-[10px] leading-relaxed text-muted-foreground">
                          {tier.blurb}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </ScreenView>
        )}

        {screen === "login-code" && loginChallenge && (
          <ScreenView key="login-code">
            <button
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
              onClick={backToLoginFromCode}
            >
              <ArrowLeft className="h-4 w-4" />
              返回登录
            </button>

            <div className="mb-3.5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 p-3">
              <MailCheck className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
              <div className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                密码已验证。验证码已发送到{" "}
                <b className="break-all text-foreground">
                  {loginChallenge.emailHint}
                </b>
                。没收到请查看垃圾邮件。
              </div>
            </div>

            <label className="mb-1 block text-xs text-muted-foreground">
              验证码
            </label>
            <input
              className={`${inputCls} text-center text-lg font-semibold tracking-[0.4em]`}
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={loginCode}
              // 只留数字：粘贴带空格的验证码也能直接用。
              onChange={(e) =>
                setLoginCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              onKeyDown={(e) => e.key === "Enter" && handleVerifyLoginCode()}
            />

            <button
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:brightness-105 disabled:opacity-60"
              disabled={busy || loginCode.length !== 6}
              onClick={handleVerifyLoginCode}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              完成登录
            </button>

            {/* 没有「重发」按钮：重发就是重走密码那条腿，得重新输密码。画一个
                点了要求输密码的按钮只会让人以为坏了，不如直说。 */}
            <div className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
              验证码 {Math.round(loginChallenge.expiresIn / 60)} 分钟内有效。
              没收到？返回登录重新输入密码即可再发一次。
            </div>
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

      {/* 排队生效的换档服务端不提供取消端点，也不退现金。页面上那行小字挡
          不住误操作，这里再拦一道。要不要拦、弹窗说什么（什么时候生效、钱不退
          现金但改主意时会折成抵扣、期间当前套餐照常可用）都在报价的
          confirm_title / confirm_message 里，日期按本地时区填。 */}
      <ConfirmDialog
        isOpen={confirmQueue}
        title={checkout?.quote.confirm_title ?? ""}
        message={
          checkout
            ? fillServerText(checkout.quote.confirm_message, {
                new_valid_from: formatPlanDate(checkout.quote.new_valid_from),
                new_valid_until: formatPlanDate(checkout.quote.new_valid_until),
              })
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
            checkout.units,
            checkout.asExtra,
          );
        }}
      />
    </div>
  );
}
