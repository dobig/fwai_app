import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  isClaudeSafeModelId,
  metaToRows,
  rowsToMeta,
  validateDesktopForm,
  type ClaudeDesktopModelRow,
} from "@/lib/claudeDesktopModels";
import type { ProviderMeta } from "@/types";
import {
  getGatewayBaseURL,
  gatewayOAuthAccessToken,
} from "@/lib/api/llm-gateway";

export interface ClaudeDesktopProviderFormProps {
  submitLabel: string;
  onSubmit: (values: {
    name: string;
    settingsConfig: string;
    meta: ProviderMeta;
  }) => Promise<void> | void;
  onCancel: () => void;
  onSubmittingChange?: (isSubmitting: boolean) => void;
  initialData?: {
    name?: string;
    settingsConfig?: Record<string, unknown>;
    meta?: ProviderMeta;
  };
  showButtons?: boolean;
}

function readEnv(
  settingsConfig: Record<string, unknown> | undefined,
  key: string,
): string {
  const env = settingsConfig?.env;
  if (!env || typeof env !== "object") return "";
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Claude App（Claude Desktop）的供应商表单。
 *
 * 刻意不复用 `ProviderForm`:那里有十几处 `appId === "claude"` 的分支(预设、模板
 * 变量、通用配置片段、API Key 链接),对 Desktop 一个都不适用。Desktop 只需要
 * endpoint + key,外加一份写进 profile 的模型清单。
 *
 * 两处和别的表单不同的地方:
 * 1. 模型名硬校验。不合规不是「这个模型不可用」,而是 Desktop 的 fail-all 校验
 *    拒收整组,模型菜单会整个空掉——所以这里不给「仍要保存」的台阶。
 * 2. 保存后要提示重启 Desktop:它只在启动时读 profile。
 */
export function ClaudeDesktopProviderForm({
  submitLabel,
  onSubmit,
  onCancel,
  onSubmittingChange,
  initialData,
  showButtons = true,
}: ClaudeDesktopProviderFormProps) {
  const isEditMode = Boolean(initialData);
  const [name, setName] = useState(initialData?.name ?? "");
  // 新增时拿当前登录的网关凭据预填。token 是一串 JWT，要用户自己从别处抄过来
  // 不现实；而这发生在用户点「添加」之后，不是后台替他写配置。
  const [baseUrl, setBaseUrl] = useState(
    () =>
      readEnv(initialData?.settingsConfig, "ANTHROPIC_BASE_URL") ||
      (isEditMode ? "" : getGatewayBaseURL().replace(/\/+$/, "")),
  );
  const [apiKey, setApiKey] = useState(
    () =>
      readEnv(initialData?.settingsConfig, "ANTHROPIC_AUTH_TOKEN") ||
      (isEditMode ? "" : gatewayOAuthAccessToken()),
  );
  const [rows, setRows] = useState<ClaudeDesktopModelRow[]>(() =>
    metaToRows(initialData?.meta),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateRow = (index: number, patch: Partial<ClaudeDesktopModelRow>) => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const blocker = useMemo(
    () => validateDesktopForm({ baseUrl, apiKey, rows }),
    [baseUrl, apiKey, rows],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (!name.trim()) {
      toast.error("请填写供应商名称");
      return;
    }
    if (blocker) {
      toast.error(blocker);
      return;
    }

    setIsSubmitting(true);
    onSubmittingChange?.(true);
    try {
      await onSubmit({
        name: name.trim(),
        settingsConfig: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: baseUrl.trim(),
            ANTHROPIC_AUTH_TOKEN: apiKey.trim(),
          },
        }),
        meta: {
          ...(initialData?.meta ?? {}),
          // 只支持直连：proxy 模式要本机路由服务，不在这个应用里。
          claudeDesktopMode: "direct",
          claudeDesktopModelRoutes: rowsToMeta(rows),
        },
      });
    } finally {
      setIsSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
    <form
      id="provider-form"
      onSubmit={handleSubmit}
      className="space-y-6 glass rounded-xl p-6 border border-white/10"
    >
      <div className="space-y-2">
        <Label htmlFor="cd-name">名称</Label>
        <Input
          id="cd-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="LLM Gateway"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cd-base-url">API 端点</Label>
        <Input
          id="cd-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.fwai.space"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cd-api-key">API Key</Label>
        <Input
          id="cd-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <Label>模型清单</Label>
          <p className="text-xs text-muted-foreground">
            勾选要在 Claude App 模型菜单里出现的档位。全不勾则由 Claude App
            自己去读网关的 /v1/models。
          </p>
          <p className="text-xs text-muted-foreground">
            只支持 Claude 系模型:直连模式把请求原样发给上游,不改写模型名。 GPT
            等其它模型请在 Claude Code 里用。
          </p>
        </div>

        {rows.map((row, index) => {
          const model = row.model.trim();
          const invalid =
            row.enabled && model !== "" && !isClaudeSafeModelId(model);
          return (
            <div
              key={`${row.role}-${index}`}
              className="flex items-center gap-3"
            >
              <Checkbox
                id={`cd-row-${index}`}
                checked={row.enabled}
                onCheckedChange={(checked) =>
                  updateRow(index, { enabled: checked === true })
                }
              />
              <Label
                htmlFor={`cd-row-${index}`}
                className="w-16 shrink-0 text-xs text-muted-foreground"
              >
                {row.role}
              </Label>
              <Input
                aria-label={`${row.role} 模型名`}
                value={row.model}
                onChange={(event) =>
                  updateRow(index, { model: event.target.value })
                }
                className={invalid ? "border-destructive" : undefined}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={row.supports1m}
                  onCheckedChange={(checked) =>
                    updateRow(index, { supports1m: checked === true })
                  }
                  aria-label={`${row.role} 支持 1M 上下文`}
                />
                1M
              </label>
            </div>
          );
        })}

        {blocker && (
          <p role="alert" className="text-xs text-destructive">
            {blocker}
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        切换后需要重启 Claude App 才生效(macOS 上要按 ⌘Q
        彻底退出,只关窗口不行)。
      </p>

      {showButtons && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
