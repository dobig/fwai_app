import {
  useQuery,
  type UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { providersApi, settingsApi, type AppId } from "@/lib/api";
import { forwardingFlagKey, isForwardable } from "@/lib/apps";
import type { Provider, Settings } from "@/types";

const sortProviders = (
  providers: Record<string, Provider>,
): Record<string, Provider> => {
  const sortedEntries = Object.values(providers)
    .sort((a, b) => {
      const indexA = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
      const indexB = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
      if (indexA !== indexB) {
        return indexA - indexB;
      }

      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA === timeB) {
        return a.name.localeCompare(b.name, "zh-CN");
      }
      return timeA - timeB;
    })
    .map((provider) => [provider.id, provider] as const);

  return Object.fromEntries(sortedEntries);
};

export interface ProvidersQueryData {
  providers: Record<string, Provider>;
  currentProviderId: string;
}

export const useProvidersQuery = (
  appId: AppId,
): UseQueryResult<ProvidersQueryData> => {
  return useQuery({
    queryKey: ["providers", appId],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let providers: Record<string, Provider> = {};
      let currentProviderId = "";

      try {
        providers = await providersApi.getAll(appId);
      } catch (error) {
        console.error("获取供应商列表失败:", error);
      }

      try {
        currentProviderId = await providersApi.getCurrent(appId);
      } catch (error) {
        console.error("获取当前供应商失败:", error);
      }

      return {
        providers: sortProviders(providers),
        currentProviderId,
      };
    },
  });
};

/// 某个 app 是否正在走网关转发。
///
/// 以后端的备份为准——备份在，就说明 live 配置里还压着网关的 endpoint。
/// localStorage 只是拿不到后端时的兜底：它和真实磁盘状态可能不一致（换了机器、
/// 手动改过配置），而按钮显示什么直接决定用户会不会去点「结束转发」把配置还原。
///
/// 用 query 而不是组件里的 state，是为了能在用户于供应商列表里手动切走之后自动
/// 重读——那种切换会让后端作废备份，不重读就会一直显示「结束转发」。
export const useForwardingQuery = (appId: AppId): UseQueryResult<boolean> => {
  return useQuery({
    queryKey: ["forwarding", appId],
    enabled: isForwardable(appId),
    queryFn: async () => {
      try {
        return await providersApi.isForwarding(appId);
      } catch {
        return localStorage.getItem(forwardingFlagKey(appId)) === "1";
      }
    },
  });
};

export const useSettingsQuery = (): UseQueryResult<Settings> => {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => settingsApi.get(),
  });
};
