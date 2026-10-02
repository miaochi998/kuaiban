import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  ESCALATE_AFTER_MS,
  allDayTodosOn,
  batchReminders,
  collectDueReminders,
  fireAtFor,
  isQuietTime,
  quietHoursEndAt,
  type DueReminder,
} from "../src";
import { MON, todo } from "./helpers";

const at = (iso: string) => new Date(iso);

describe("提醒时刻", () => {
  it("提前 0 分钟 = 待办本身的时刻", () => {
    const t = todo({ title: "开会", date: MON, time: "09:30" });
    const f = fireAtFor(t, MON)!;
    expect(f.getHours()).toBe(9);
    expect(f.getMinutes()).toBe(30);
  });

  it("提前 15 分钟", () => {
    const t = todo({ title: "开会", date: MON, time: "09:30", remindBefore: 15 });
    const f = fireAtFor(t, MON)!;
    expect(f.getHours()).toBe(9);
    expect(f.getMinutes()).toBe(15);
  });

  it("提前量可以跨到前一小时", () => {
    const t = todo({ title: "开会", date: MON, time: "09:00", remindBefore: 30 });
    const f = fireAtFor(t, MON)!;
    expect(f.getHours()).toBe(8);
    expect(f.getMinutes()).toBe(30);
  });

  it("全天事项不产生提醒（走早上汇总，不逐条打扰）", () => {
    const t = todo({ title: "买咖啡豆", date: MON });
    expect(t.time).toBeNull();
    expect(fireAtFor(t, MON)).toBeNull();
  });

  it("关掉提醒就不响", () => {
    const t = { ...todo({ title: "x", date: MON, time: "09:30" }), remind: false };
    expect(fireAtFor(t, MON)).toBeNull();
  });

  it("提醒升级延迟常量是 60 秒", () => {
    expect(ESCALATE_AFTER_MS).toBe(60_000);
  });
});

describe("时间窗收集", () => {
  const meeting = todo({ title: "开会", date: MON, time: "09:30" });

  it("落在窗口内 → 响", () => {
    const due = collectDueReminders([meeting], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"));
    expect(due.map((d) => d.todo.title)).toEqual(["开会"]);
  });

  it("窗口之前 → 不响", () => {
    const due = collectDueReminders([meeting], at("2026-06-15T09:00:00"), at("2026-06-15T08:59:00"));
    expect(due).toHaveLength(0);
  });

  it("窗口之后 → 不响（避免重复补响）", () => {
    const due = collectDueReminders([meeting], at("2026-06-15T10:00:00"), at("2026-06-15T09:40:00"));
    expect(due).toHaveLength(0);
  });

  it("用时间窗而不是「等于此刻」，所以睡眠/卡顿后不会漏", () => {
    // 电脑睡了 20 分钟，醒来后一次调用补上
    const due = collectDueReminders([meeting], at("2026-06-15T09:50:00"), at("2026-06-15T09:29:00"));
    expect(due.map((d) => d.todo.title)).toEqual(["开会"]);
  });

  it("已完成的不响", () => {
    const done = {
      ...meeting,
      status: "done" as const,
      completedAt: at("2026-06-15T09:00:00").toISOString(),
    };
    expect(collectDueReminders([done], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"))).toHaveLength(0);
  });

  it("软删除的不响", () => {
    const gone = { ...meeting, deletedAt: at("2026-06-15T08:00:00").toISOString() };
    expect(collectDueReminders([gone], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"))).toHaveLength(0);
  });

  it("重复任务在发生的当天响", () => {
    const daily = todo({ title: "喝水提醒", date: "2026-06-01", time: "09:30", repeat: { kind: "daily" } });
    const due = collectDueReminders([daily], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"));
    expect(due.map((d) => d.todo.title)).toEqual(["喝水提醒"]);
  });

  it("重复任务今天已完成 → 不再响", () => {
    const daily = todo({ title: "喝水", date: "2026-06-01", time: "09:30", repeat: { kind: "daily" } });
    const doneToday = { ...daily, lastDoneDate: MON };
    expect(collectDueReminders([doneToday], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"))).toHaveLength(0);
  });

  it("跨业务日：昨天 23:00 的提醒在凌晨补响", () => {
    // 2026-06-15 00:10 的业务日仍是 06-14
    const night = todo({ title: "夜班交接", date: "2026-06-14", time: "23:00" });
    const due = collectDueReminders(
      [night],
      at("2026-06-15T00:10:00"),
      at("2026-06-14T22:59:00"),
      { quietHours: { ...DEFAULT_QUIET_HOURS, enabled: false } },
    );
    expect(due.map((d) => d.todo.title)).toEqual(["夜班交接"]);
  });

  it("更早的逾期事项不会反复补响（它们进「昨日未完成」区）", () => {
    const old = todo({ title: "三天前的事", date: "2026-06-12", time: "09:30" });
    expect(collectDueReminders([old], at("2026-06-15T09:30:05"), at("2026-06-15T09:29:50"))).toHaveLength(0);
  });

  it("多条按时间先后返回", () => {
    const todos = [
      todo({ title: "晚", date: MON, time: "10:00" }),
      todo({ title: "早", date: MON, time: "09:30" }),
    ];
    const due = collectDueReminders(todos, at("2026-06-15T10:00:05"), at("2026-06-15T09:29:00"));
    expect(due.map((d) => d.todo.title)).toEqual(["早", "晚"]);
  });
});

describe("免打扰", () => {
  it("22:00–07:00 跨午夜", () => {
    expect(isQuietTime(at("2026-06-15T23:00:00"), DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isQuietTime(at("2026-06-16T03:00:00"), DEFAULT_QUIET_HOURS)).toBe(true);
    expect(isQuietTime(at("2026-06-16T07:00:00"), DEFAULT_QUIET_HOURS)).toBe(false);
    expect(isQuietTime(at("2026-06-15T12:00:00"), DEFAULT_QUIET_HOURS)).toBe(false);
    expect(isQuietTime(at("2026-06-15T21:59:00"), DEFAULT_QUIET_HOURS)).toBe(false);
  });

  it("关掉就不算免打扰", () => {
    expect(isQuietTime(at("2026-06-15T23:00:00"), { ...DEFAULT_QUIET_HOURS, enabled: false })).toBe(false);
  });

  it("非跨午夜的区间也支持", () => {
    const lunch = { enabled: true, start: "12:00", end: "13:00" };
    expect(isQuietTime(at("2026-06-15T12:30:00"), lunch)).toBe(true);
    expect(isQuietTime(at("2026-06-15T13:00:00"), lunch)).toBe(false);
  });

  it("非法区间视为不免打扰", () => {
    expect(isQuietTime(at("2026-06-15T12:00:00"), { enabled: true, start: "abc", end: "13:00" })).toBe(false);
    expect(isQuietTime(at("2026-06-15T12:00:00"), { enabled: true, start: "12:00", end: "12:00" })).toBe(false);
  });

  it("夜间到点的提醒被过滤掉（只闪不响，早上再说）", () => {
    const night = todo({ title: "夜宵", date: MON, time: "23:00" });
    const due = collectDueReminders(
      [night],
      at("2026-06-15T23:00:10"),
      at("2026-06-15T22:59:50"),
      { quietHours: DEFAULT_QUIET_HOURS },
    );
    expect(due).toHaveLength(0);
  });

  it("quietHoursEndAt 指向下一个免打扰结束时刻", () => {
    const e = quietHoursEndAt(at("2026-06-15T23:00:00"), DEFAULT_QUIET_HOURS);
    expect(e.getDate()).toBe(16);
    expect(e.getHours()).toBe(7);
    expect(e.getMinutes()).toBe(0);
  });

  it("免打扰已结束时指向明天", () => {
    const e = quietHoursEndAt(at("2026-06-15T08:00:00"), DEFAULT_QUIET_HOURS);
    expect(e.getDate()).toBe(16);
  });
});

describe("提醒风暴合并 —— 生死线", () => {
  const mk = (title: string): DueReminder => ({
    todo: todo({ title, date: MON, time: "09:30" }),
    occurrenceDate: MON,
    fireAt: at("2026-06-15T09:30:00"),
  });

  it("0 条", () => {
    const b = batchReminders([]);
    expect(b.count).toBe(0);
    expect(b.merged).toBe(false);
  });

  it("1 条不合并，直接用标题", () => {
    const b = batchReminders([mk("交周报")]);
    expect(b.merged).toBe(false);
    expect(b.headline).toBe("交周报");
  });

  it("多条合并成一条 —— 绝不弹 N 个窗口", () => {
    const b = batchReminders([mk("交周报"), mk("回电话"), mk("评审原型")]);
    expect(b.merged).toBe(true);
    expect(b.count).toBe(3);
    expect(b.headline).toBe("你有 3 件事到点了");
    expect(b.preview).toEqual(["交周报", "回电话", "评审原型"]);
  });

  it("预览最多 4 条，不会撑爆气泡", () => {
    const b = batchReminders([mk("a"), mk("b"), mk("c"), mk("d"), mk("e"), mk("f")]);
    expect(b.count).toBe(6);
    expect(b.preview).toHaveLength(4);
  });
});

describe("全天事项汇总", () => {
  it("只挑出当天、没时间、还没做的", () => {
    const todos = [
      todo({ title: "买咖啡豆", date: MON }),
      todo({ title: "开会", date: MON, time: "09:30" }),
      todo({ title: "明天的事", date: "2026-06-16" }),
    ];
    expect(allDayTodosOn(todos, MON).map((t) => t.title)).toEqual(["买咖啡豆"]);
  });

  it("已完成的不进汇总", () => {
    const t = todo({ title: "买咖啡豆", date: MON });
    const done = { ...t, status: "done" as const, completedAt: at("2026-06-15T09:00:00").toISOString() };
    expect(allDayTodosOn([done], MON)).toHaveLength(0);
  });
});
