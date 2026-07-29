import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Provider } from "@/types";
import type { AppId } from "./types";

export interface ProviderSortUpdate {
  id: string;
  sortIndex: number;
}

export interface ProviderSwitchEvent {
  appType: AppId;
  providerId: string;
}

export interface SwitchResult {
  warnings: string[];
}

export interface OpenTerminalOptions {
  cwd?: string;
}

export const providersApi = {
  async getAll(appId: AppId): Promise<Record<string, Provider>> {
    return await invoke("get_providers", { app: appId });
  },

  async getCurrent(appId: AppId): Promise<string> {
    return await invoke("get_current_provider", { app: appId });
  },

  async add(
    provider: Provider,
    appId: AppId,
    addToLive?: boolean,
  ): Promise<boolean> {
    return await invoke("add_provider", { provider, app: appId, addToLive });
  },

  async update(
    provider: Provider,
    appId: AppId,
    originalId?: string,
  ): Promise<boolean> {
    return await invoke("update_provider", {
      provider,
      app: appId,
      originalId,
    });
  },

  async delete(id: string, appId: AppId): Promise<boolean> {
    return await invoke("delete_provider", { id, app: appId });
  },

  async removeManaged(id: string, appId: AppId): Promise<boolean> {
    return await invoke("remove_managed_provider", { id, app: appId });
  },

  /// 开启转发：只把 endpoint + api key 覆盖到 live 配置，其余内容原样保留。
  /// 转发前那两个字段会被备份，stopForwarding 时还原。
  async startForwarding(
    provider: Provider,
    appId: AppId,
    token: string,
    baseUrl: string,
  ): Promise<void> {
    return await invoke("start_forwarding", {
      provider,
      app: appId,
      token,
      baseUrl,
    });
  },

  /// 结束转发：只还原 endpoint + api key（原本没有就删掉），转发期间用户
  /// 对配置做的其它修改全部保留。
  async stopForwarding(appId: AppId): Promise<void> {
    return await invoke("stop_forwarding", { app: appId });
  },

  async isForwarding(appId: AppId): Promise<boolean> {
    return await invoke("is_forwarding", { app: appId });
  },

  async switch(id: string, appId: AppId): Promise<SwitchResult> {
    return await invoke("switch_provider", { id, app: appId });
  },

  async importDefault(appId: AppId): Promise<boolean> {
    return await invoke("import_default_config", { app: appId });
  },

  async updateTrayMenu(): Promise<boolean> {
    return await invoke("update_tray_menu");
  },

  async updateSortOrder(
    updates: ProviderSortUpdate[],
    appId: AppId,
  ): Promise<boolean> {
    return await invoke("update_providers_sort_order", { updates, app: appId });
  },

  async onSwitched(
    handler: (event: ProviderSwitchEvent) => void,
  ): Promise<UnlistenFn> {
    return await listen("provider-switched", (event) => {
      const payload = event.payload as ProviderSwitchEvent;
      handler(payload);
    });
  },

  /**
   * 打开指定提供商的终端
   * 任何提供商都可以打开终端，不受是否为当前激活提供商的限制
   * 终端会使用该提供商特定的 API 配置，不影响全局设置
   */
  async openTerminal(
    providerId: string,
    appId: AppId,
    options?: OpenTerminalOptions,
  ): Promise<boolean> {
    const { cwd } = options ?? {};
    return await invoke("open_provider_terminal", {
      providerId,
      app: appId,
      cwd,
    });
  },
};
