import type { AppId } from "@/lib/api";

export const ALL_APPS: AppId[] = ["claude", "codex", "gemini"];

/// 能走网关转发的 app。Gemini 不在里面：后端的 capture_live/apply_live 对它
/// 是空操作，网关也不提供 Gemini 的上游。
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

export const APP_DISPLAY_NAME: Record<AppId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};
