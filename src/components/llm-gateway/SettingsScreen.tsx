import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  setSecretRedaction,
  type GatewayUserProfile,
} from "@/lib/api/llm-gateway";

// 设置屏：账号级、存在服务端的开关。和本地的转发开关不同，这里的每一项都跟着
// 账号走 —— 换台电脑登录，设置还在。
export function SettingsScreen({
  user,
  onProfile,
}: {
  user: GatewayUserProfile;
  // 服务端返回的最新资料。以它为准回写缓存，不以本地开关的状态为准。
  onProfile: (user: GatewayUserProfile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const enabled = user.redact_secrets === true;

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const profile = await setSecretRedaction(next);
      onProfile(profile);
      toast.success(next ? "已开启发送前隐藏密钥" : "已关闭发送前隐藏密钥");
    } catch {
      toast.error("设置失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
              <KeyRound className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">发送前隐藏密钥</div>
              <div className="text-[11px] text-muted-foreground">
                {enabled ? "已开启" : "未开启"}
              </div>
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="发送前隐藏密钥"
          />
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          开启后，发往模型的提示里如果出现 API
          Key、令牌、私钥等凭据，会先被替换成占位符再发送。
          模型看不到原值，所以依赖这些值的操作（比如让模型直接调用某个接口）可能会失败。
        </p>
      </div>
    </div>
  );
}
