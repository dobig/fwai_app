// 客户端版本上报与升级提示。
//
// 客户端此前不上报真实版本：app_version 是写死的字符串，几十个版本一直没变，
// 服务端因此无法区分新旧客户端。换档 epic 里这个缺陷造成了一个无法修复的
// 降级（详见 #14）。这次把版本改成构建期注入并随每个请求上报，是为**下一次**
// 破坏性变更铺路 —— 已发布的老版本永远不会带这个头，服务端对它们只能按
// 「无版本信息」处理。
//
// 版本头是**自报**的，服务端只拿它做提示和统计，不作为安全边界。

import { useSyncExternalStore } from "react";

/** 请求头名。服务端对应 dobig/llm_gateway#195。 */
export const CLIENT_VERSION_HEADER = "X-Client-Version";
export const CLIENT_UPGRADE_HEADER = "X-Client-Upgrade";

/**
 * 构建期从 package.json 注入。**不要改成手写常量** —— 手写常量迟早会忘记
 * 更新，那正是当前这个 bug 的成因。
 *
 * 兜底成 "0.0.0" 只为了让没配 define 的环境（比如别人直接 ts-node 引这个
 * 模块）不至于抛 ReferenceError；正常构建和单测都走 define。
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** 产品名前缀让服务端能区分是哪个客户端在报，将来还会有别的端。 */
export const CLIENT_VERSION_VALUE = `fwai_app/${APP_VERSION}`;

// suggest：有新版本，提一句，不打断任何操作。
// required：这个版本已经跟不上服务端的契约了，购买流程会算错账，必须挡。
export type ClientUpgradeSignal = "required" | "suggest";

// ---------------------------------------------------------------------------
// 一个极小的外部 store。
//
// 信号来自 gatewayRequest 的响应头，而消费者在 React 树里（App 弹 toast、
// 订阅面板挡购买入口）。让 api 层直接 import toast 会把展示逻辑埋进网络层，
// 而且订阅面板也拿不到；所以中间隔一个 store。
// ---------------------------------------------------------------------------

let signal: ClientUpgradeSignal | null = null;
const listeners = new Set<() => void>();

/**
 * 记录一次响应里的升级提示。传 null / 无法识别的值都视为「服务端这次没说」。
 *
 * **不降级**：一旦收到 required 就不会被后续的 suggest 或空值改回去。响应头
 * 是逐个请求发的，中间任何一次没带（比如打到了尚未更新的实例、或者走了不
 * 校验版本的端点）都不该让已经挡住的购买入口重新放开——那会变成一个随机
 * 时灵时不灵的门。
 */
export function recordUpgradeSignal(raw: string | null | undefined): void {
  if (signal === "required") return;
  const next: ClientUpgradeSignal | null =
    raw === "required" ? "required" : raw === "suggest" ? "suggest" : null;
  // 没有该头时什么都不做：老网关不会发这个头，不能被解读成「没有更新」而
  // 把已经显示的提示撤掉。
  if (next === null || next === signal) return;
  signal = next;
  for (const listener of listeners) listener();
}

export function getUpgradeSignal(): ClientUpgradeSignal | null {
  return signal;
}

/** 仅供测试：清掉进程内的信号。 */
export function resetUpgradeSignal(): void {
  signal = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件里读当前的升级信号。 */
export function useClientUpgradeSignal(): ClientUpgradeSignal | null {
  return useSyncExternalStore(subscribe, getUpgradeSignal, getUpgradeSignal);
}
