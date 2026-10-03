import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_HOURS,
  completeOccurrence,
  dueReminders,
  isMissedReminder,
  reminderKey,
  softDelete,
  ESCALATE_AFTER_MS,
  allDayTodosOn,
  batchReminders,
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

  it("免打扰期间提醒**仍然算到点**（只闪图标，外壳据此决定不响不弹）", () => {
    const night = todo({ title: "夜宵", date: MON, time: "23:00" });
    const at2330 = at("2026-06-15T23:00:10");
    expect(dueReminders([night], at2330)).toHaveLength(1);
    expect(isQuietTime(at2330, DEFAULT_QUIET_HOURS)).toBe(true);
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
  const mk = (title: string): DueReminder => {
    const t = todo({ title, date: MON, time: "09:30" });
    return {
      todo: t,
      occurrenceDate: MON,
      fireAt: at("2026-06-15T09:30:00"),
      key: reminderKey(t.id, MON),
    };
  };

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

// ─────────────────────────────────────────────────────────────
// 提醒队列用的「所有未处理提醒」—— 关键性质：
// 不依赖调用间隔，所以睡眠 / 卡顿 / 重启后重新算一遍都不会漏；只看当前业务日。
// ─────────────────────────────────────────────────────────────

describe("dueReminders：所有已到点、还没处理的", () => {
  it("返回全部，而不只是某个时间窗内的", () => {
    const todos = [
      todo({ title: "九点半", date: MON, time: "09:30" }),
      todo({ title: "十点", date: MON, time: "10:00" }),
    ];
    // 11:00 一次调用就该拿到两条（时间窗方案若 since 设成 10:30 就只会拿到一条）
    const due = dueReminders(todos, at("2026-06-15T11:00:00"));
    expect(due.map((d) => d.todo.title)).toEqual(["九点半", "十点"]);
  });

  it("幂等：同一时刻反复调用结果一致（队列靠它做重算）", () => {
    const todos = [todo({ title: "开会", date: MON, time: "09:30" })];
    const a = dueReminders(todos, at("2026-06-15T09:40:00"));
    const b = dueReminders(todos, at("2026-06-15T09:40:00"));
    expect(a.map((d) => d.key)).toEqual(b.map((d) => d.key));
  });

  it("还没到点的不返回", () => {
    const todos = [todo({ title: "下午", date: MON, time: "17:00" })];
    expect(dueReminders(todos, at("2026-06-15T09:00:00"))).toHaveLength(0);
  });

  it("已完成的不返回", () => {
    const t = completeOccurrence(todo({ title: "开会", date: MON, time: "09:30" }), MON, at("2026-06-15T09:00:00"));
    expect(dueReminders([t], at("2026-06-15T09:40:00"))).toHaveLength(0);
  });

  it("软删除的不返回", () => {
    const t = softDelete(todo({ title: "开会", date: MON, time: "09:30" }), at("2026-06-15T08:00:00"));
    expect(dueReminders([t], at("2026-06-15T09:40:00"))).toHaveLength(0);
  });

  it("全天事项（没时间）不产生提醒", () => {
    const todos = [todo({ title: "买咖啡豆", date: MON })];
    expect(dueReminders(todos, at("2026-06-15T23:00:00"))).toHaveLength(0);
  });

  it("昨天到点没处理的，今天不再响 —— 它已经在「昨日未完成」区里了", () => {
    const todos = [
      todo({ title: "前天", date: "2026-06-13", time: "09:30" }),
      todo({ title: "昨天", date: "2026-06-14", time: "09:30" }),
    ];
    // 用响铃重复打扰昨天的事，正是这个软件要消灭的噪音
    expect(dueReminders(todos, at("2026-06-15T10:00:00"))).toEqual([]);
  });

  it("每日任务一天只响一次（曾经会连昨天的份一起响）", () => {
    const daily = todo({ title: "吃药", date: "2026-06-01", time: "09:30", repeat: { kind: "daily" } });
    expect(dueReminders([daily], at("2026-06-15T09:40:00"))).toHaveLength(1);
  });

  it("跨业务日：凌晨 3 点仍算前一天，昨天的提醒照样响", () => {
    const todos = [todo({ title: "夜班", date: "2026-06-14", time: "23:00" })];
    // 2026-06-15 00:30 的业务日 = 06-14
    expect(dueReminders(todos, at("2026-06-15T00:30:00"))).toHaveLength(1);
  });

  it("到点越久的排越前面（最该处理的先看到）", () => {
    const todos = [
      todo({ title: "晚", date: MON, time: "10:00" }),
      todo({ title: "早", date: MON, time: "09:00" }),
    ];
    expect(dueReminders(todos, at("2026-06-15T11:00:00")).map((d) => d.todo.title)).toEqual(["早", "晚"]);
  });

  it("重复任务在发生的当天到点", () => {
    const daily = todo({ title: "吃药", date: "2026-06-01", time: "09:30", repeat: { kind: "daily" } });
    expect(dueReminders([daily], at("2026-06-15T09:40:00"))).toHaveLength(1);
  });

  it("重复任务今天已完成 → 不再响", () => {
    const daily = todo({ title: "吃药", date: "2026-06-01", time: "09:30", repeat: { kind: "daily" } });
    const done = completeOccurrence(daily, MON, at("2026-06-15T09:00:00"));
    expect(dueReminders([done], at("2026-06-15T09:40:00"))).toHaveLength(0);
  });

  it("key 形如 待办id@业务日，且推后/静音按它记账", () => {
    const t = todo({ title: "开会", date: MON, time: "09:30" });
    const due = dueReminders([t], at("2026-06-15T09:40:00"));
    expect(due[0]!.key).toBe(reminderKey(t.id, MON));
    expect(due[0]!.key).toBe(`${t.id}@2026-06-15`);
  });
});

describe("错过判定", () => {
  it("刚过 10 分钟不算错过", () => {
    const t = todo({ title: "开会", date: MON, time: "09:30" });
    const item = dueReminders([t], at("2026-06-15T09:39:00"))[0]!;
    expect(isMissedReminder(item, at("2026-06-15T09:39:00"))).toBe(false);
  });

  it("过了一个多小时算错过（软件刚打开时会标注出来）", () => {
    const t = todo({ title: "开会", date: MON, time: "09:30" });
    const item = dueReminders([t], at("2026-06-15T11:00:00"))[0]!;
    expect(isMissedReminder(item, at("2026-06-15T11:00:00"))).toBe(true);
  });
});
