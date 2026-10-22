/**
 * 服务端公告的「已读」状态。
 *
 * 每条公告只弹一次：用户关掉之后把它的 id 记在这里，之后再拉到也不弹。管理员
 * 修改一条已发布的公告不会让它重新弹出——要重新提醒就新建一条，这一点在管理后台
 * 的表单上有说明。
 */
const SEEN_KEY = "fwai-announcements-seen";

/**
 * 最多记住多少条。公告 id 是服务端随机生成的，留得再久也不会和新公告撞上，
 * 封顶只是不让这个 key 无限长大。生效中的公告服务端最多返回 20 条，200 足够
 * 覆盖它们。
 */
const MAX_SEEN = 200;

export { SEEN_KEY as ANNOUNCEMENTS_SEEN_KEY };

/**
 * 读已读列表。任何异常（没有 key、值是垃圾、localStorage 不可用）都当作「全都
 * 没读过」：多弹一次只是打扰，漏掉一条重要公告才是真正的损失。
 */
function readSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === "string");
    }
    // 自愈：别让坏值一直留在那儿
    window.localStorage.removeItem(SEEN_KEY);
  } catch (error) {
    console.warn("[announcements] 读取已读公告失败:", error);
  }
  return [];
}

/** 过滤出还没弹过的公告，保持服务端给的顺序（旧的在前）。 */
export function unseenAnnouncements<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set(readSeen());
  return items.filter((item) => !seen.has(item.id));
}

/** 记住这条公告已经弹过了。 */
export function markAnnouncementSeen(id: string): void {
  try {
    const seen = readSeen().filter((existing) => existing !== id);
    seen.push(id);
    window.localStorage.setItem(
      SEEN_KEY,
      JSON.stringify(seen.slice(-MAX_SEEN)),
    );
  } catch (error) {
    console.warn("[announcements] 记录已读公告失败:", error);
  }
}
