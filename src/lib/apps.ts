import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";

export const ALL_APPS: AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
];

/// 能走网关转发的 app。
///
/// Gemini 不在里面：后端的 capture_live/apply_live 对它是空操作，网关也不提供
/// Gemini 的上游。
///
/// Claude Desktop 也不在里面，但原因不同：它走的是标准切换路径（把供应商写进
/// Desktop 自己的 3P profile）。转发那套「备份两个字段再覆盖」是为了保住用户在
/// live 文件里的其它修改，而 profile 的写入本来就只动我们独占的那几个键。
/// Desktop 的 token 跟随见 `syncDesktopGatewayEntry`。
export const FORWARDABLE_APPS = ["claude", "codex"] as const;

export type ForwardableApp = (typeof FORWARDABLE_APPS)[number];

export const isForwardable = (app: AppId): app is ForwardableApp =>
  (FORWARDABLE_APPS as readonly string[]).includes(app);

/// 转发标志的 localStorage key，按 app 分开存。
///
/// 只是读不到后端时的兜底——权威状态是后端有没有那份 endpoint/key 备份。
/// 以前是一个全局 key，于是 Claude 开着转发时去 Codex 点网关条目也会被放行。
export const forwardingFlagKey = (app: AppId) =>
  `llm-gateway-forwarding-on:${app}`;

/// 读不到后端 settings 时的默认可见性。
///
/// 以前这份字面量在 App.tsx 和 AppVisibilitySettings.tsx 各写了一遍，加一个 app
/// 就要记得改两处。
export const DEFAULT_VISIBLE_APPS: VisibleApps = {
  claude: true,
  "claude-desktop": true,
  codex: true,
  gemini: true,
};

export const APP_DISPLAY_NAME: Record<AppId, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini",
};
