import { describe, expect, it } from "vitest";
import {
  buildDailyView,
  completeOccurrence,
  isAlive,
  isoWeekday,
  monthGrid,
  skipOccurrence,
  sortForList,
  todosOnDate,
  type Todo,
} from "../src";
import { MON, todo } from "./helpers";

const NOW = new Date("2026-06-15T09:00:00"); // 周一，业务日 = 2026-06-15

function view(todos: Todo[]) {
  return buildDailyView(todos, { now: NOW });
}

describe("一份数据，四个视角", () => {
  it("随笔 = 日期为空的", () => {
    const v = view([todo({ title: "灵感" }), todo({ title: "今天的事", date: MON })]);
    expect(v.inbox.map((t) => t.title)).toEqual(["灵感"]);
    expect(v.today.map((t) => t.title)).toEqual(["今天的事"]);
  });

  it("明天清单", () => {
    const v = view([todo({ title: "明天的事", date: "2026-06-16" })]);
    expect(v.tomorrow.map((t) => t.title)).toEqual(["明天的事"]);
    expect(v.tomorrowDate).toBe("2026-06-16");
  });

  it("更远的未来不进日视图（交给日历）", () => {
    const v = view([todo({ title: "下个月", date: "2026-07-15" })]);
    expect(v.today).toHaveLength(0);
    expect(v.tomorrow).toHaveLength(0);
    expect(v.overdue).toHaveLength(0);
    expect(v.inbox).toHaveLength(0);
  });

  it("取消掉的不出现", () => {
    const t = skipOccurrence(todo({ title: "x", date: MON }), MON, NOW);
    const v = view([t]);
    expect(isAlive(t)).toBe(false);
    expect(v.today).toHaveLength(0);
    expect(v.overdue).toHaveLength(0);
  });

  it("软删除的不出现", () => {
    const t = { ...todo({ title: "x", date: MON }), deletedAt: NOW.toISOString() };
    expect(view([t]).today).toHaveLength(0);
  });
});

describe("逾期顺延 —— 本软件的灵魂", () => {
  it("昨天没做完的自动出现在「昨日未完成」，并算出拖了几天", () => {
    const v = view([
      todo({ title: "给客户回电话", date: "2026-06-12" }),
      todo({ title: "报销单", date: "2026-06-14" }),
    ]);
    expect(v.overdue.map((o) => [o.todo.title, o.overdueDays])).toEqual([
      ["给客户回电话", 3],
      ["报销单", 1],
    ]);
  });

  it("拖满 3 天进入 needsAttention（该劝用户改期 / 拆小 / 放弃了）", () => {
    const v = view([
      todo({ title: "拖了3天", date: "2026-06-12" }),
      todo({ title: "拖了2天", date: "2026-06-13" }),
    ]);
    expect(v.needsAttention.map((o) => o.todo.title)).toEqual(["拖了3天"]);
  });

  it("不需要任何定时任务：只是业务日变了", () => {
    const t = todo({ title: "x", date: MON });
    // 当晚 23:00 还在今天
    expect(buildDailyView([t], { now: new Date("2026-06-15T23:00:00") }).overdue).toHaveLength(0);
    // 凌晨 3 点仍算今天
    expect(buildDailyView([t], { now: new Date("2026-06-16T03:00:00") }).overdue).toHaveLength(0);
    // 凌晨 4 点翻页，自动进入逾期
    const next = buildDailyView([t], { now: new Date("2026-06-16T04:00:00") });
    expect(next.overdue.map((o) => o.todo.title)).toEqual(["x"]);
    expect(next.businessDate).toBe("2026-06-16");
  });

  it("逾期事项仍保留原始日期（拖了多久这个真相不能丢）", () => {
    const v = view([todo({ title: "x", date: "2026-06-10" })]);
    expect(v.overdue[0]!.todo.date).toBe("2026-06-10");
  });

  it("remainingCount = 逾期 + 今天未完成", () => {
    const v = view([
      todo({ title: "a", date: "2026-06-12" }),
      todo({ title: "b", date: MON }),
      todo({ title: "c", date: MON }),
      todo({ title: "d", date: "2026-06-16" }),
      todo({ title: "随笔" }),
    ]);
    expect(v.remainingCount).toBe(3);
  });
});

describe("重复任务的处理", () => {
  it("今天该做的重复任务进今天清单", () => {
    const v = view([todo({ title: "喝水", date: "2026-06-01", repeat: { kind: "daily" } })]);
    expect(v.today.map((t) => t.title)).toEqual(["喝水"]);
  });

  it("重复任务永远不进逾期区（否则会让人麻木）", () => {
    const v = view([todo({ title: "喝水", date: "2026-06-01", repeat: { kind: "daily" } })]);
    expect(v.overdue).toHaveLength(0);
  });

  it("今天不发生的重复任务不进今天", () => {
    const v = view([todo({ title: "每周三", date: "2026-06-03", repeat: { kind: "weekly", weekdays: [3] } })]);
    expect(v.today).toHaveLength(0);
  });

  it("明天该做的重复任务进明天清单", () => {
    const v = view([todo({ title: "每周二", date: "2026-06-02", repeat: { kind: "weekly", weekdays: [2] } })]);
    expect(v.tomorrow.map((t) => t.title)).toEqual(["每周二"]);
  });

  it("完成本次后进已完成区，明天照旧", () => {
    const t0 = todo({ title: "喝水", date: "2026-06-01", repeat: { kind: "daily" } });
    const t1 = completeOccurrence(t0, MON, NOW);
    const v = view([t1]);
    expect(v.today).toHaveLength(0);
    expect(v.doneToday.map((x) => x.title)).toEqual(["喝水"]);
    // 第二天它又回到今天清单
    const tomorrow = buildDailyView([t1], { now: new Date("2026-06-16T09:00:00") });
    expect(tomorrow.today.map((x) => x.title)).toEqual(["喝水"]);
  });
});

describe("已完成区", () => {
  it("今天完成的进 doneToday", () => {
    const t = completeOccurrence(todo({ title: "x", date: MON }), MON, new Date("2026-06-15T10:00:00"));
    const v = view([t]);
    expect(v.doneToday.map((x) => x.title)).toEqual(["x"]);
    expect(v.today).toHaveLength(0);
  });

  it("昨天完成的今天不显示", () => {
    const t = completeOccurrence(todo({ title: "x", date: "2026-06-14" }), "2026-06-14", new Date("2026-06-14T10:00:00"));
    const v = view([t]);
    expect(v.doneToday).toHaveLength(0);
    expect(v.overdue).toHaveLength(0);
  });

  it("凌晨 1 点完成的算前一个业务日", () => {
    const t = completeOccurrence(todo({ title: "x", date: MON }), MON, new Date("2026-06-16T01:00:00"));
    // 2026-06-16 02:00 的业务日仍是 06-15
    const v = buildDailyView([t], { now: new Date("2026-06-16T02:00:00") });
    expect(v.businessDate).toBe("2026-06-15");
    expect(v.doneToday.map((x) => x.title)).toEqual(["x"]);
  });

  it("完成的越晚排越前", () => {
    const early = completeOccurrence(todo({ title: "早", date: MON }), MON, new Date("2026-06-15T09:00:00"));
    const late = completeOccurrence(todo({ title: "晚", date: MON }), MON, new Date("2026-06-15T11:00:00"));
    expect(view([early, late]).doneToday.map((x) => x.title)).toEqual(["晚", "早"]);
  });
});

describe("排序", () => {
  it("按时间升序，没时间的排最后", () => {
    const v = view([
      todo({ title: "没时间", date: MON }),
      todo({ title: "17点", date: MON, time: "17:00" }),
      todo({ title: "9点半", date: MON, time: "09:30" }),
    ]);
    expect(v.today.map((t) => t.title)).toEqual(["9点半", "17点", "没时间"]);
  });

  it("同一时间按创建时间", () => {
    const a = todo({ title: "a", date: MON, time: "09:00" }, "2026-06-15T08:00:00");
    const b = todo({ title: "b", date: MON, time: "09:00" }, "2026-06-15T08:01:00");
    expect([b, a].sort(sortForList).map((t) => t.title)).toEqual(["a", "b"]);
  });

  it("逾期区也按时间排", () => {
    const v = view([
      todo({ title: "无时间", date: "2026-06-13" }),
      todo({ title: "14点", date: "2026-06-13", time: "14:00" }),
    ]);
    expect(v.overdue.map((o) => o.todo.title)).toEqual(["14点", "无时间"]);
  });

  it("随笔最新的在最上面", () => {
    const old = todo({ title: "旧" }, "2026-06-15T08:00:00");
    const fresh = todo({ title: "新" }, "2026-06-15T08:30:00");
    expect(view([old, fresh]).inbox.map((t) => t.title)).toEqual(["新", "旧"]);
  });
});

describe("日历", () => {
  it("todosOnDate 同时命中一次性与重复发生", () => {
    const todos = [
      todo({ title: "一次性", date: "2026-06-20" }),
      todo({ title: "每周六", date: "2026-06-06", repeat: { kind: "weekly", weekdays: [6] } }),
    ];
    // 两条都没时间、createdAt 相同 → 按创建顺序（id 已零填充，序稳定）
    expect(todosOnDate(todos, "2026-06-20").map((t) => t.title)).toEqual(["一次性", "每周六"]);
  });

  it("monthGrid 是 42 格、从周一开始、覆盖整月", () => {
    const g = monthGrid(2026, 6);
    expect(g).toHaveLength(42);
    expect(isoWeekday(g[0]!)).toBe(1);
    expect(g).toContain("2026-06-01");
    expect(g).toContain("2026-06-30");
  });

  it("月初不是周一时会补齐上个月的格子", () => {
    // 2026-07-01 是周三
    const g = monthGrid(2026, 7);
    expect(isoWeekday(g[0]!)).toBe(1);
    expect(g[0]).toBe("2026-06-29");
    expect(g).toContain("2026-07-01");
    expect(g).toContain("2026-07-31");
  });
});
