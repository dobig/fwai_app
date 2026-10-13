import { toast } from "sonner";
import type { TFunction } from "i18next";
import { settingsApi, type AppUpdateInfo } from "@/lib/api";

/** 同一时刻只跑一次安装：toast 按钮和 About 徽标可能被连点 */
let installing = false;

/**
 * 应用一个检测到的更新。
 *
 * 能应用内安装就下载、校验签名、安装后重启；成功时这个 Promise 不会返回
 * （进程被替换）。不能安装（更新清单不可用，只拿到了 GitHub 的版本号）
 * 或安装失败时，退回打开下载页让用户手动装。
 */
export async function applyAppUpdate(
  info: AppUpdateInfo,
  t: TFunction,
): Promise<void> {
  if (!info.installable) {
    await settingsApi.openExternal(info.releaseUrl);
    return;
  }
  if (installing) return;
  installing = true;

  const toastId = toast.loading(t("settings.updating"), {
    duration: Infinity,
  });
  try {
    await settingsApi.installAppUpdate();
  } catch (error) {
    console.error("[appUpdate] Failed to install update:", error);
    toast.error(t("settings.updateFailed"), { id: toastId, duration: 6000 });
    await settingsApi.openExternal(info.releaseUrl).catch((openError) => {
      console.error("[appUpdate] Failed to open releases page:", openError);
    });
  } finally {
    installing = false;
  }
}
