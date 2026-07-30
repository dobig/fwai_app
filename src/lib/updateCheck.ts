/**
 * 新版本提醒的"已忽略"状态。
 *
 * 关掉某个版本的 toast 之后就不再为该版本弹窗；更高的版本会重新弹。
 * About 页的徽标不读这里的状态——那是有意的不对称：关掉提醒只是不想被打扰，
 * 不等于不想再知道有更新。
 */
const UPDATE_DISMISSED_KEY = "fwai-update-dismissed-version";

/** 只做形状校验，不做版本比较（比较在 Rust 侧用 semver crate 做） */
const VERSION_SHAPE = /^\d+\.\d+\.\d+/;

export { UPDATE_DISMISSED_KEY };

/**
 * 该版本的 toast 是否已被用户关掉过。
 *
 * 判定用"不等"而不是"大于"：Rust 侧已经确定 latest 比当前版本新，而同一时刻
 * GitHub 上只有一个最新正式版，所以"存的值 ≠ 当前 latest" 就等价于"这个版本
 * 我没关过"——一个不可能算错的字符串比较，不需要在前端再实现一遍 semver。
 *
 * 任何异常（没有 key、值是垃圾、localStorage 不可用）都降级为「未忽略」，
 * 即倾向于提醒。静默才是会让用户丢失信息的失败方向。
 */
export function isVersionDismissed(latest: string): boolean {
  try {
    const stored = window.localStorage.getItem(UPDATE_DISMISSED_KEY);
    if (!stored) return false;

    if (!VERSION_SHAPE.test(stored)) {
      // 自愈：别让坏值一直留在那儿反复走这条分支
      window.localStorage.removeItem(UPDATE_DISMISSED_KEY);
      return false;
    }

    return stored === latest;
  } catch (error) {
    console.warn("[updateCheck] 读取已忽略版本失败:", error);
    return false;
  }
}

/** 记住用户关掉了这个版本的提醒 */
export function dismissVersion(version: string): void {
  try {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch (error) {
    console.warn("[updateCheck] 记录已忽略版本失败:", error);
  }
}
