import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ToggleRow } from "@/components/ui/toggle-row";
import {
  GATEWAY_LOGIN_CHANGED_EVENT,
  loadGatewayLogin,
  setSecretRedaction,
  updateGatewayUserProfile,
  type GatewayLoginResult,
} from "@/lib/api/llm-gateway";

// llm_gateway 账号级设置。和上面那些本机设置不同，这里的每一项存在服务端、跟着
// 账号走 —— 换台电脑登录还在。没登录网关时整块不显示：开关没有可以写的地方。
export function GatewayAccountSettings() {
  const [login, setLogin] = useState<GatewayLoginResult | null>(() =>
    loadGatewayLogin(),
  );
  const [busy, setBusy] = useState(false);

  // 在右下角面板里登录、登出之后，这里跟着变。
  useEffect(() => {
    const sync = () => setLogin(loadGatewayLogin());
    window.addEventListener(GATEWAY_LOGIN_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(GATEWAY_LOGIN_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  if (!login) return null;
  const enabled = login.user.redact_secrets === true;

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      // 以服务端返回的资料为准回写，不以开关自己的状态为准：写失败时开关不动。
      const profile = await setSecretRedaction(next);
      updateGatewayUserProfile(profile);
      toast.success(next ? "已开启发送前隐藏密钥" : "已关闭发送前隐藏密钥");
    } catch {
      toast.error("设置失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">llm_gateway 账号</h3>
        <span className="text-xs text-muted-foreground">
          {login.user.username} · 跟着账号走，换台电脑登录也生效
        </span>
      </div>

      <div className="space-y-3">
        <ToggleRow
          icon={<KeyRound className="h-4 w-4 text-amber-500" />}
          title="发送前隐藏密钥"
          description="发给模型的内容里出现 API Key、令牌、私钥等凭据时，先替换成占位符再发送。模型看不到原值，需要它直接使用这些值的操作可能会失败。"
          checked={enabled}
          disabled={busy}
          onCheckedChange={(value) => void toggle(value)}
        />
      </div>
    </section>
  );
}
