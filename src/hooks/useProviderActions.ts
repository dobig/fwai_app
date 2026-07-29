import { useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { providersApi, settingsApi, type AppId } from "@/lib/api";
import { forwardingFlagKey } from "@/lib/apps";
import type { Provider } from "@/types";
import {
  useAddProviderMutation,
  useUpdateProviderMutation,
  useDeleteProviderMutation,
  useSwitchProviderMutation,
} from "@/lib/query";
import { extractErrorMessage } from "@/utils/errorUtils";

/**
 * Hook for managing provider actions (add, update, delete, switch)
 * Extracts business logic from App.tsx
 */
export function useProviderActions(activeApp: AppId) {
  const { t } = useTranslation();

  const addProviderMutation = useAddProviderMutation(activeApp);
  const updateProviderMutation = useUpdateProviderMutation(activeApp);
  const deleteProviderMutation = useDeleteProviderMutation(activeApp);
  const switchProviderMutation = useSwitchProviderMutation(activeApp);

  // Claude 插件同步逻辑
  const syncClaudePlugin = useCallback(
    async (provider: Provider) => {
      if (activeApp !== "claude") return;

      try {
        const settings = await settingsApi.get();
        if (!settings?.enableClaudePluginIntegration) {
          return;
        }

        const isOfficial = provider.category === "official";
        await settingsApi.applyClaudePluginConfig({ official: isOfficial });

        // 静默执行，不显示成功通知
      } catch (error) {
        const detail =
          extractErrorMessage(error) ||
          t("notifications.syncClaudePluginFailed", {
            defaultValue: "同步 Claude 插件失败",
          });
        toast.error(detail, { duration: 4200 });
      }
    },
    [activeApp, t],
  );

  // 添加供应商
  const addProvider = useCallback(
    async (provider: Omit<Provider, "id">) => {
      await addProviderMutation.mutateAsync(provider);
    },
    [addProviderMutation],
  );

  // 更新供应商
  const updateProvider = useCallback(
    async (provider: Provider, originalId?: string) => {
      await updateProviderMutation.mutateAsync({ provider, originalId });

      // 更新托盘菜单（失败不影响主操作）
      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after updating provider",
          trayError,
        );
      }
    },
    [updateProviderMutation],
  );

  // 切换供应商
  const switchProvider = useCallback(
    async (provider: Provider) => {
      // LLM Gateway 供应商的写入需要「转发已开启」与「启用」同时成立：
      // 转发关闭（或未登录）时拦下切换，避免绕过 dock 把 config 写进 live。
      //
      // 按当前 app 问后端，而不是读一个全局标志：转发本来就是按 app 隔离的，
      // 读全局标志的话 Claude 开着转发时去 Codex 点这个条目也会被放行。问后端
      // 还顺带修掉「用户已经手动切走、备份早已作废，标志却还留着」那个洞——那
      // 时候放行等于触发一次整份写盘。
      if (provider.id === "llm-gateway-local") {
        let forwardingOn: boolean;
        try {
          forwardingOn = await providersApi.isForwarding(activeApp);
        } catch {
          forwardingOn =
            localStorage.getItem(forwardingFlagKey(activeApp)) === "1";
        }
        if (!forwardingOn) {
          toast.info("请先在 LLM Gateway 面板登录并开启转发，再启用该供应商");
          return;
        }
      }
      try {
        const result = await switchProviderMutation.mutateAsync(provider.id);
        await syncClaudePlugin(provider);

        // Show backfill warning if present
        if (result?.warnings?.length) {
          toast.warning(
            t("notifications.backfillWarning", {
              defaultValue:
                "切换成功，但旧供应商配置回填失败，您手动修改的配置可能未保存",
            }),
            { duration: 5000 },
          );
        }

        toast.success(
          t("notifications.switchSuccess", { defaultValue: "切换成功！" }),
          {
            closeButton: true,
          },
        );
      } catch {
        // 错误提示由 mutation 处理
      }
    },
    [activeApp, switchProviderMutation, syncClaudePlugin, t],
  );

  // 删除供应商
  const deleteProvider = useCallback(
    async (id: string) => {
      await deleteProviderMutation.mutateAsync(id);
    },
    [deleteProviderMutation],
  );

  return {
    addProvider,
    updateProvider,
    switchProvider,
    deleteProvider,
    isLoading:
      addProviderMutation.isPending ||
      updateProviderMutation.isPending ||
      deleteProviderMutation.isPending ||
      switchProviderMutation.isPending,
  };
}
