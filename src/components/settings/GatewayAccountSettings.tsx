import { useEffect, useState } from "react";
import { KeyRound, Minimize2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { ToggleRow } from "@/components/ui/toggle-row";
import {
  GATEWAY_LOGIN_CHANGED_EVENT,
  loadGatewayLogin,
  setSecretRedaction,
  setToolCompression,
  updateGatewayUserProfile,
  type GatewayLoginResult,
} from "@/lib/api/llm-gateway";

// 每个账号开关：写哪个接口、提示说什么。以服务端返回的资料为准回写，不以
// 开关自己的状态为准 —— 写失败时开关不动。
const SETTINGS = {
  redact: {
    write: (enabled: boolean) => setSecretRedaction(enabled),
    name: "发送前隐藏密钥",
  },
  compress: {
    write: (enabled: boolean) => setToolCompression(enabled),
    name: "压缩工具输出",
  },
} as const;
type SettingKey = keyof typeof SETTINGS;

// llm_gateway 账号级设置，放在设置页「高级」标签里。和本机设置不同，这里的每一项
// 存在服务端、跟着账号走 —— 换台电脑登录还在。没登录网关时开关没有可以写的地方，
// 只显示一句去哪里登录。
export function GatewayAccountSettings() {
  const [login, setLogin] = useState<GatewayLoginResult | null>(() =>
    loadGatewayLogin(),
  );
  // 两个开关各自一把锁：一个在写的时候，另一个照样能点。
  const [busy, setBusy] = useState<Set<SettingKey>>(() => new Set());

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

  // 没登录网关时给一句提示，而不是整页空白：这一页现在只有账号级设置。
  if (!login) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        登录 llm_gateway
        后可在这里设置账号相关选项（如发送前隐藏密钥、压缩工具输出）。
        <br />
        在右下角的 llm_gateway 面板里登录。
      </div>
    );
  }

  async function toggle(key: SettingKey, next: boolean) {
    if (busy.has(key)) return;
    const { write, name } = SETTINGS[key];
    setBusy((s) => new Set(s).add(key));
    try {
      const profile = await write(next);
      updateGatewayUserProfile(profile);
      toast.success(next ? `已开启${name}` : `已关闭${name}`);
    } catch {
      toast.error("设置失败，请稍后重试");
    } finally {
      setBusy((s) => {
        const rest = new Set(s);
        rest.delete(key);
        return rest;
      });
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
          title={SETTINGS.redact.name}
          description="发给模型的内容里出现 API Key、令牌、私钥等凭据时，先替换成占位符再发送。模型看不到原值，需要它直接使用这些值的操作可能会失败。"
          checked={login.user.redact_secrets === true}
          disabled={busy.has("redact")}
          onCheckedChange={(value) => void toggle("redact", value)}
        />
        {/* 只说效果，不讲压缩分几层、怎么截断 —— 用户要决定的只是「省不省」。 */}
        <ToggleRow
          icon={<Minimize2 className="h-4 w-4 text-primary" />}
          title={SETTINGS.compress.name}
          description="命令行输出发给模型前先精简：去掉颜色码、进度条等无用内容，过长的输出只保留关键部分，更省用量。模型需要时会自动取回完整内容。"
          checked={login.user.tool_compression === true}
          disabled={busy.has("compress")}
          onCheckedChange={(value) => void toggle("compress", value)}
        />
      </div>
    </section>
  );
}
