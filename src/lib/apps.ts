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
/// Claude Desktop 在里面。它的「live」是 Desktop 自己的 3P profile 而不是某个
/// settings.json，但对用户来说没有区别：面板上一个开关，接上或撤掉。还原时按
/// 动手前的快照（deploymentMode / appliedId）回滚，所以本来就在用 3P 的人不会
/// 被按回官方登录。
export const FORWARDABLE_APPS = ["claude", "claude-desktop", "codex"] as const;

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
