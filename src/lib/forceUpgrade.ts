// 服务端强制升级。
//
// 管理员在后台设了「强制最低版本」之后，低于它的 App 被锁住：弹出关不掉的
// 升级窗口，所有转发关掉并还原原有配置，网关也会对这个版本的请求回 426。
// 和 clientUpgrade.ts 里的 required 信号不同，这里拿到的是确切的最低版本号，
// 而且以 /v1/client-version 为准：管理员把门槛调低了，下次查询就能解锁。

import { useSyncExternalStore } from "react";
import { APP_VERSION } from "@/lib/clientUpgrade";

/** 网关拒绝旧版本时的错误码（HTTP 426）。 */
export const CLIENT_UPGRADE_REQUIRED_CODE = "client_upgrade_required";

type Version = [number, number, number];

/** 读 "1.9.0"，容忍 "v" 前缀和 "-beta" / "+sha" 后缀；读不懂返回 null。 */
export function parseVersion(raw: string): Version | null {
  const core = raw.trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums: Version = [0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return null;
    nums[i] = Number(parts[i]);
  }
  return nums;
}

/** current 是否低于 min。任何一边读不懂都算「不低于」：不能因为解析失败锁人。 */
export function isBelowVersion(current: string, min: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export interface ForceUpgradeState {
  /** 服务端要求的最低版本；426 没带版本号时为空串。 */
  minVersion: string;
}

let state: ForceUpgradeState | null = null;
const listeners = new Set<() => void>();

function set(next: ForceUpgradeState | null): void {
  if (state === next) return;
  if (state && next && state.minVersion === next.minVersion) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * 按 /v1/client-version 的结果更新锁定状态。这是权威来源：门槛为空或者当前
 * 版本已经够了就解锁，管理员撤掉门槛不用等用户重启。
 */
export function applyMinVersion(minVersion: string): void {
  set(
    minVersion && isBelowVersion(APP_VERSION, minVersion)
      ? { minVersion }
      : null,
  );
}

/**
 * 某个请求被网关以 426 拒绝了。服务端已经认定这个版本太旧，直接锁，不再
 * 自己比较——客户端和服务端的比较规则万一有出入，以服务端为准。
 */
export function recordUpgradeRefusal(minVersion: unknown): void {
  set({ minVersion: typeof minVersion === "string" ? minVersion : "" });
}

export function getForceUpgrade(): ForceUpgradeState | null {
  return state;
}

export function isUpgradeLocked(): boolean {
  return state !== null;
}

/** 仅供测试。 */
export function resetForceUpgrade(): void {
  set(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useForceUpgrade(): ForceUpgradeState | null {
  return useSyncExternalStore(subscribe, getForceUpgrade, getForceUpgrade);
}
