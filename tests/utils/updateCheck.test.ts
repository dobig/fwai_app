import { beforeEach, describe, expect, it } from "vitest";
import {
  UPDATE_DISMISSED_KEY,
  dismissVersion,
  isVersionDismissed,
} from "@/lib/updateCheck";

describe("updateCheck 已忽略版本", () => {
  beforeEach(() => {
    window.localStorage.removeItem(UPDATE_DISMISSED_KEY);
  });

  it("没有记录时应当提醒", () => {
    expect(isVersionDismissed("1.6.0")).toBe(false);
  });

  it("关掉过的版本不再提醒", () => {
    dismissVersion("1.6.0");
    expect(window.localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("1.6.0");
    expect(isVersionDismissed("1.6.0")).toBe(true);
  });

  it("更高的版本重新提醒", () => {
    dismissVersion("1.6.0");
    expect(isVersionDismissed("1.6.1")).toBe(false);
    expect(isVersionDismissed("2.0.0")).toBe(false);
  });

  it("垃圾值降级为提醒，并把坏值清掉", () => {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, "not-a-version");

    expect(isVersionDismissed("1.6.0")).toBe(false);
    // 自愈：坏值不该留着反复走这条分支
    expect(window.localStorage.getItem(UPDATE_DISMISSED_KEY)).toBeNull();
  });

  it("空字符串也降级为提醒", () => {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, "");
    expect(isVersionDismissed("1.6.0")).toBe(false);
  });
});
