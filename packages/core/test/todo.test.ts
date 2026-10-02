import { describe, expect, it } from "vitest";
import {
  completeOccurrence,
  createTodo,
  isAlive,
  isOccurrenceDone,
  isOccurrencePending,
  moveToDate,
  overdueDays,
  restore,
  skipOccurrence,
  softDelete,
  uncompleteOccurrence,
  updateTodo,
} from "../src";
import { MON, todo } from "./helpers";

const NOW = new Date("2026-06-15T09:00:00");

describe("createTodo 默认值（体现产品意图）", () => {
  it("有时间的默认开提醒", () => {
    const t = createTodo({ title: "开会", date: MON, time: "09:30" }, { now: NOW, id: "a" });
    expect(t.remind).toBe(true);
    expect(t.time).toBe("09:30");
    expect(t.remindBefore).toBe(0);
  });

  it("没时间的（全天）默认不开提醒 —— 不逐条打扰", () => {
    const t = createTodo({ title: "买咖啡豆" }, { now: NOW, id: "b" });
    expect(t.remind).toBe(false);
    expect(t.time).toBeNull();
  });

  it("不指定日期 = 未排期（进随笔区）", () => {
    expect(createTodo({ title: "灵感" }, { now: NOW }).date).toBeNull();
  });

  it("默认是不重复、pending、未删除", () => {
    const t = createTodo({ title: "x" }, { now: NOW });
    expect(t.repeat).toEqual({ kind: "none" });
    expect(t.status).toBe("pending");
    expect(t.deletedAt).toBeNull();
    expect(t.completedAt).toBeNull();
    expect(t.lastDoneDate).toBeNull();
    expect(t.skippedDates).toEqual([]);
  });

  it("内容去掉前后空格", () => {
    expect(createTodo({ title: "  写周报  " }, { now: NOW }).title).toBe("写周报");
  });

  it("空内容直接报错（宁早失败）", () => {
    expect(() => createTodo({ title: "   " }, { now: NOW })).toThrow();
    expect(() => createTodo({ title: "" }, { now: NOW })).toThrow();
  });

  it("时间被规范化", () => {
    expect(createTodo({ title: "x", time: "9:5" }, { now: NOW }).time).toBe("09:05");
  });

  it("每个 id 唯一", () => {
    const a = createTodo({ title: "a" }, { now: NOW });
    const b = createTodo({ title: "b" }, { now: NOW });
    expect(a.id).not.toBe(b.id);
  });
});

describe("完成", () => {
  it("一次性：status 变 done，记下 completedAt", () => {
    const t = completeOccurrence(todo({ title: "x", date: MON }), MON, NOW);
    expect(t.status).toBe("done");
    expect(t.completedAt).toBe(NOW.toISOString());
  });

  it("重复任务：勾选只完成本次，系列继续", () => {
    const t0 = todo({ title: "吃药", date: MON, repeat: { kind: "daily" } });
    const t1 = completeOccurrence(t0, MON, NOW);
    expect(t1.lastDoneDate).toBe(MON);
    expect(t1.status).toBe("pending"); // 系列没被"完成"掉
    expect(t1.repeat).toEqual({ kind: "daily" });
    expect(isOccurrenceDone(t1, MON)).toBe(true);
    expect(isOccurrenceDone(t1, "2026-06-16")).toBe(false); // 明天还要做
  });

  it("重复任务完成今天不影响昨天的判定", () => {
    const t0 = todo({ title: "吃药", date: "2026-06-01", repeat: { kind: "daily" } });
    const t1 = completeOccurrence(t0, MON, NOW);
    expect(isOccurrenceDone(t1, "2026-06-14")).toBe(false);
  });

  it("取消完成：一次性", () => {
    const t1 = completeOccurrence(todo({ title: "x", date: MON }), MON, NOW);
    const t2 = uncompleteOccurrence(t1, MON, NOW);
    expect(t2.status).toBe("pending");
    expect(t2.completedAt).toBeNull();
  });

  it("取消完成：重复任务只撤销「当前这次」，不动别人的", () => {
    const t0 = todo({ title: "吃药", date: "2026-06-01", repeat: { kind: "daily" } });
    const t1 = completeOccurrence(t0, MON, NOW);
    expect(uncompleteOccurrence(t1, MON, NOW).lastDoneDate).toBeNull();
    // 试图撤销的是另一天 → 保持原样
    expect(uncompleteOccurrence(t1, "2026-06-14", NOW).lastDoneDate).toBe(MON);
  });
});

describe("跳过本次", () => {
  it("重复任务跳过当天，系列继续", () => {
    const t0 = todo({ title: "周会", date: MON, repeat: { kind: "weekly", weekdays: [1] } });
    const t1 = skipOccurrence(t0, MON, NOW);
    expect(t1.skippedDates).toEqual([MON]);
    expect(isOccurrencePending(t1, MON)).toBe(false);
    expect(isOccurrencePending(t1, "2026-06-22")).toBe(true); // 下周照旧
  });

  it("重复跳过同一天不会叠加", () => {
    const t0 = todo({ title: "周会", date: MON, repeat: { kind: "weekly", weekdays: [1] } });
    const t1 = skipOccurrence(skipOccurrence(t0, MON, NOW), MON, NOW);
    expect(t1.skippedDates).toEqual([MON]);
  });

  it("一次性待办「跳过」等价于取消", () => {
    const t = skipOccurrence(todo({ title: "x", date: MON }), MON, NOW);
    expect(t.status).toBe("cancelled");
    expect(isAlive(t)).toBe(false);
  });
});

describe("逾期天数（派生，不是存储的计数）", () => {
  it("不逾期", () => {
    expect(overdueDays(todo({ title: "x", date: MON }), NOW)).toBe(0);
    expect(overdueDays(todo({ title: "x", date: "2026-06-16" }), NOW)).toBe(0);
  });
  it("拖了 2 天", () => {
    expect(overdueDays(todo({ title: "x", date: "2026-06-13" }), NOW)).toBe(2);
  });
  it("跨月也正确", () => {
    expect(overdueDays(todo({ title: "x", date: "2026-05-31" }), NOW)).toBe(15);
  });
  it("已完成的不算逾期", () => {
    const t = completeOccurrence(todo({ title: "x", date: "2026-06-13" }), "2026-06-13", NOW);
    expect(overdueDays(t, NOW)).toBe(0);
  });
  it("重复任务不产生逾期（否则「每天喝水」会天天挂在逾期区）", () => {
    const t = todo({ title: "喝水", date: "2026-06-01", repeat: { kind: "daily" } });
    expect(overdueDays(t, NOW)).toBe(0);
  });
  it("随笔不算逾期", () => {
    expect(overdueDays(todo({ title: "灵感" }), NOW)).toBe(0);
  });
  it("凌晨 3 点还没翻天", () => {
    // 2026-06-16 03:00 的业务日仍是 06-15
    expect(overdueDays(todo({ title: "x", date: MON }), new Date("2026-06-16T03:00:00"))).toBe(0);
  });
});

describe("改期", () => {
  it("搬到今天后不再逾期", () => {
    const t = moveToDate(todo({ title: "x", date: "2026-06-13" }), MON, NOW);
    expect(overdueDays(t, NOW)).toBe(0);
  });
  it("也可以搬回随笔（date = null）", () => {
    expect(moveToDate(todo({ title: "x", date: MON }), null, NOW).date).toBeNull();
  });
});

describe("软删除（同步用「删除优先」）", () => {
  it("留下 deletedAt 并失去 alive", () => {
    const t = softDelete(todo({ title: "x", date: MON }), NOW);
    expect(t.deletedAt).toBe(NOW.toISOString());
    expect(isAlive(t)).toBe(false);
  });
  it("可以撤销删除", () => {
    const t = restore(softDelete(todo({ title: "x", date: MON }), NOW), NOW);
    expect(t.deletedAt).toBeNull();
    expect(isAlive(t)).toBe(true);
  });
});

describe("更新", () => {
  it("改内容会 trim", () => {
    expect(updateTodo(todo({ title: "a" }), { title: " b " }, NOW).title).toBe("b");
  });
  it("空内容报错", () => {
    expect(() => updateTodo(todo({ title: "a" }), { title: "  " }, NOW)).toThrow();
  });
  it("是纯函数，不改原对象", () => {
    const t0 = todo({ title: "a" });
    const snapshot = JSON.stringify(t0);
    updateTodo(t0, { title: "b", note: "x" }, NOW);
    expect(JSON.stringify(t0)).toBe(snapshot);
  });
  it("全部实体操作都是纯函数", () => {
    const t0 = todo({ title: "a", date: MON, repeat: { kind: "daily" } });
    const snapshot = JSON.stringify(t0);
    completeOccurrence(t0, MON, NOW);
    uncompleteOccurrence(t0, MON, NOW);
    skipOccurrence(t0, MON, NOW);
    moveToDate(t0, "2026-06-20", NOW);
    softDelete(t0, NOW);
    expect(JSON.stringify(t0)).toBe(snapshot);
  });
});
