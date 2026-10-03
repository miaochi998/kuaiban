import { describe, expect, it, vi } from "vitest";
import {
  COACH_HINTS,
  fallbackHint,
  loadDismissedHints,
  pickHint,
  saveDismissedHints,
  type HintStorage,
} from "../src/lib/hints";

const none = new Set<string>();

describe("挑提示：先教，教完再闭嘴", () => {
  it("没教过时优先给「直接写时间」—— 它最值钱", () => {
    const picked = pickHint({ tab: "today", hasTarget: true, dismissed: none });
    expect(picked.coach).toBe(true);
    expect(picked.hint.id).toBe("time-shortcut");
  });

  it("教过之后就换下一条", () => {
    const picked = pickHint({
      tab: "today",
      hasTarget: true,
      dismissed: new Set(["time-shortcut"]),
    });
    expect(picked.hint.id).toBe("repeat-keyword");
  });

  it("不在当前页签适用的技巧会被跳过", () => {
    // overdue-carry 只在今天页签；随笔页签应跳过它、也跳过已学过的，
    // 直接给随笔专属的那条
    const picked = pickHint({
      tab: "inbox",
      hasTarget: true,
      dismissed: new Set(["time-shortcut", "repeat-keyword"]),
    });
    expect(picked.hint.id).toBe("inbox-schedule");
  });

  it("全部教完之后给常驻备忘，而不再是教学", () => {
    const all = new Set(COACH_HINTS.map((h) => h.id));
    const picked = pickHint({ tab: "today", hasTarget: true, dismissed: all });
    expect(picked.coach).toBe(false);
    expect(picked.hint.id).toBe("fb-today");
  });

  it("状态指引优先于教学提示：日历没选日期时，绝不能被「📌 钉住」挤掉", () => {
    // 什么都没教过，但日历还没选日期 —— 这条指引比任何技巧都重要
    const picked = pickHint({ tab: "calendar", hasTarget: false, dismissed: none });
    expect(picked.coach).toBe(false);
    expect(picked.hint.text).toContain("点日历上的某一天");
  });

  it("日历：没选日期时提示先点一天", () => {
    const all = new Set(COACH_HINTS.map((h) => h.id));
    const picked = pickHint({ tab: "calendar", hasTarget: false, dismissed: all });
    expect(picked.hint.text).toContain("点日历上的某一天");
  });

  it("日历：选了日期后提示可以接着加", () => {
    const all = new Set(COACH_HINTS.map((h) => h.id));
    const picked = pickHint({ tab: "calendar", hasTarget: true, dismissed: all });
    expect(picked.hint.text).toContain("接着加");
  });

  it("每个页签都有常驻备忘，不会出现空白", () => {
    for (const tab of ["today", "tomorrow", "inbox", "calendar"] as const) {
      const h = fallbackHint({ tab, hasTarget: true });
      expect(h.text.length).toBeGreaterThan(0);
    }
  });

  it("提示文案足够短，不会把 340px 的面板撑破", () => {
    const all = new Set(COACH_HINTS.map((h) => h.id));
    const texts = [
      ...COACH_HINTS.map((h) => h.text),
      ...(["today", "tomorrow", "inbox", "calendar"] as const).map(
        (tab) => fallbackHint({ tab, hasTarget: true }).text,
      ),
    ];
    void all;
    for (const t of texts) {
      // 一行放得下大约 30 个汉字
      expect(t.length, `提示过长：${t}`).toBeLessThanOrEqual(34);
    }
  });
});

describe("记住教过哪些", () => {
  function fakeStorage(initial?: string): HintStorage & { value: string | null } {
    const box = {
      value: initial ?? null,
      getItem: () => box.value,
      setItem: (_k: string, v: string) => {
        box.value = v;
      },
    };
    return box as HintStorage & { value: string | null };
  }

  it("没有记录时返回空集合", () => {
    expect(loadDismissedHints(fakeStorage())).toEqual(new Set());
  });

  it("存了再读能拿回来", () => {
    const storage = fakeStorage();
    saveDismissedHints(storage, new Set(["a", "b"]));
    expect(loadDismissedHints(storage)).toEqual(new Set(["a", "b"]));
  });

  it("坏数据不会让它崩（顶多多教一遍）", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadDismissedHints(fakeStorage("{坏掉的"))).toEqual(new Set());
    expect(loadDismissedHints(fakeStorage('{"a":1}'))).toEqual(new Set());
    expect(loadDismissedHints(fakeStorage('["a", 1, null]'))).toEqual(new Set(["a"]));
    warn.mockRestore();
  });

  it("没有 storage（如纯 Node 环境）也不会崩", () => {
    expect(loadDismissedHints(null)).toEqual(new Set());
    expect(() => saveDismissedHints(undefined, new Set(["x"]))).not.toThrow();
  });

  it("写失败也不抛异常", () => {
    const broken: HintStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("存储满了");
      },
    };
    expect(() => saveDismissedHints(broken, new Set(["x"]))).not.toThrow();
  });
});
