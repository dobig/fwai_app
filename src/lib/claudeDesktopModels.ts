import type { ProviderMeta } from "@/types";

/**
 * Claude Desktop 能识别的模型名。
 *
 * 必须和后端 `claude_desktop_config.rs` 的 `is_claude_safe_model_id` 保持一致。
 * 这里重复一份是为了在表单里当场拦住用户，而不是等保存时吃一个后端报错。
 *
 * 为什么这么严:名字不合规不是「这个模型不可用」,而是 Desktop 的 fail-all 校验
 * **拒收整组** `inferenceModels`,模型菜单会整个空掉。
 */
const CLAUDE_ROUTE_PREFIX = "claude-";
const ANTHROPIC_CLAUDE_ROUTE_PREFIX = "anthropic/claude-";
const ONE_M_CONTEXT_MARKER = "[1m]";

/** Desktop 的 fail-all 校验认的角色段。mythos 官方未公开发布，不暴露。 */
const SAFE_ROLE_PREFIXES = ["sonnet-", "opus-", "haiku-", "fable-"] as const;

export function isClaudeSafeModelId(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  // `[1M]` 是 Claude Code 的写法，Desktop schema 不认；1M 能力走 supports1m。
  if (normalized.includes(ONE_M_CONTEXT_MARKER)) return false;

  let tail: string | null = null;
  if (normalized.startsWith(ANTHROPIC_CLAUDE_ROUTE_PREFIX)) {
    tail = normalized.slice(ANTHROPIC_CLAUDE_ROUTE_PREFIX.length);
  } else if (normalized.startsWith(CLAUDE_ROUTE_PREFIX)) {
    tail = normalized.slice(CLAUDE_ROUTE_PREFIX.length);
  }
  if (tail === null) return false;

  // 角色段后面必须还有实际标识，拒绝 `claude-sonnet-` 这类退化值。
  return SAFE_ROLE_PREFIXES.some(
    (prefix) => tail.startsWith(prefix) && tail.length > prefix.length,
  );
}

export interface ClaudeDesktopModelRow {
  /** 档位标签，只用于 UI 分组 */
  role: string;
  /** 写进 profile 的模型名 */
  model: string;
  enabled: boolean;
  supports1m: boolean;
}

/**
 * 默认的四档模型。
 *
 * 只列 Claude 系:直连模式不改写模型名,请求原样发给上游,所以 GPT 之类的名字
 * 写进去 Desktop 会直接拒收(要映射得用上游 cc-switch 的本地路由模式)。
 */
export const DEFAULT_DESKTOP_MODEL_ROWS: ClaudeDesktopModelRow[] = [
  {
    role: "Sonnet",
    model: "claude-sonnet-5-5",
    enabled: true,
    supports1m: true,
  },
  { role: "Opus", model: "claude-opus-5-5", enabled: true, supports1m: true },
  { role: "Haiku", model: "claude-haiku-5-5", enabled: true, supports1m: true },
  {
    role: "Fable",
    model: "claude-fable-5-1",
    enabled: false,
    supports1m: true,
  },
];

/**
 * 以前各版本默认勾上的模型。网关条目的模型清单恰好是其中一组时，说明用户从没
 * 改过它，换代时可以直接换成当前的默认清单；改过的（多一个、少一个、换了名字）
 * 一律不动。每次升级默认模型时把旧的那组加进来。
 */
const PREVIOUS_DEFAULT_MODEL_SETS: string[][] = [
  ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
];

/** 已存的模型清单是不是某一代没改过的旧默认值。 */
export function isPreviousDefaultRoutes(
  routes?: ProviderMeta["claudeDesktopModelRoutes"],
): boolean {
  if (!routes) return false;
  const models = Object.keys(routes).sort();
  return PREVIOUS_DEFAULT_MODEL_SETS.some((set) => {
    const expected = [...set].sort();
    return (
      expected.length === models.length &&
      expected.every((model, i) => model === models[i])
    );
  });
}

/** 把表单里的行转成 provider.meta 的形状。 */
export function rowsToMeta(
  rows: ClaudeDesktopModelRow[],
): NonNullable<ProviderMeta["claudeDesktopModelRoutes"]> {
  const routes: NonNullable<ProviderMeta["claudeDesktopModelRoutes"]> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!row.enabled || !model) continue;
    routes[model] = {
      // 直连模式不做映射：route 和上游模型必须是同一个名字。
      model,
      ...(row.supports1m ? { supports1m: true } : {}),
    };
  }
  return routes;
}

/** 从已存的 meta 还原表单行，未在 meta 里出现的档位保留默认值但不勾选。 */
export function metaToRows(meta?: ProviderMeta): ClaudeDesktopModelRow[] {
  const routes = meta?.claudeDesktopModelRoutes;
  if (!routes || Object.keys(routes).length === 0) {
    return DEFAULT_DESKTOP_MODEL_ROWS.map((row) => ({ ...row }));
  }
  const rows = DEFAULT_DESKTOP_MODEL_ROWS.map((row) => {
    const hit = routes[row.model];
    return hit
      ? { ...row, enabled: true, supports1m: hit.supports1m === true }
      : { ...row, enabled: false };
  });
  // 用户手填的、不在默认四档里的模型也要显示出来，否则编辑一次就被悄悄丢掉。
  const known = new Set(DEFAULT_DESKTOP_MODEL_ROWS.map((row) => row.model));
  for (const [model, route] of Object.entries(routes)) {
    if (known.has(model)) continue;
    rows.push({
      role: "自定义",
      model,
      enabled: true,
      supports1m: route.supports1m === true,
    });
  }
  return rows;
}

/** 表单可以保存吗。返回第一条阻塞原因，null 表示没问题。 */
export function validateDesktopForm(input: {
  baseUrl: string;
  apiKey: string;
  rows: ClaudeDesktopModelRow[];
}): string | null {
  if (!input.baseUrl.trim()) return "请填写 API 端点";
  if (!input.apiKey.trim()) return "请填写 API Key";
  for (const row of input.rows) {
    if (!row.enabled) continue;
    const model = row.model.trim();
    if (!model) return `${row.role} 勾选了但没填模型名`;
    if (!isClaudeSafeModelId(model)) {
      return `「${model}」不是 Claude App 能识别的模型名，只支持 claude-* 的 Sonnet / Opus / Haiku / Fable`;
    }
  }
  return null;
}
