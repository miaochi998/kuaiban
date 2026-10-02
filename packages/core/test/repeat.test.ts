import { describe, expect, it } from "vitest";
import {
  describeRepeat,
  nextOccurrenceOnOrAfter,
  normalizeRepeatRule,
  occursOn,
  occurrencesBetween,
} from "../src";
import { MON, todo } from "./helpers";

describe("不重复", () => {
  const t = todo({ title: "交周报", date: MON });
  it("当天发生", () => expect(occursOn(t, MON)).toBe(true));
  it("之前不发生", () => expect(occursOn(t, "2026-06-14")).toBe(false));
  it("之后也不发生", () => expect(occursOn(t, "2026-06-16")).toBe(false));
});

describe("每天", () => {
  const t = todo({ title: "吃药", date: MON, repeat: { kind: "daily" } });
  it("起始日之前不发生", () => expect(occursOn(t, "2026-06-14")).toBe(false));
  it("起始日当天发生", () => expect(occursOn(t, MON)).toBe(true));
  it("之后每天都发生", () => expect(occursOn(t, "2026-09-01")).toBe(true));
});

describe("工作日（周一到周五）", () => {
  const t = todo({ title: "打卡", date: MON, repeat: { kind: "weekdays" } });
  it("周一发生", () => expect(occursOn(t, "2026-06-15")).toBe(true));
  it("周五发生", () => expect(occursOn(t, "2026-06-19")).toBe(true));
  it("周六不发生", () => expect(occursOn(t, "2026-06-20")).toBe(false));
  it("周日不发生", () => expect(occursOn(t, "2026-06-21")).toBe(false));
  it("下周一继续发生", () => expect(occursOn(t, "2026-06-22")).toBe(true));
});

describe("每周（选周几）", () => {
  const t = todo({ title: "周会", date: MON, repeat: { kind: "weekly", weekdays: [1, 3] } });
  it("周一发生", () => expect(occursOn(t, "2026-06-15")).toBe(true));
  it("周二不发生", () => expect(occursOn(t, "2026-06-16")).toBe(false));
  it("周三发生", () => expect(occursOn(t, "2026-06-17")).toBe(true));
  it("下周一依然发生", () => expect(occursOn(t, "2026-06-22")).toBe(true));
});

describe("每月（选几号）", () => {
  const t = todo({ title: "交房租", date: "2026-06-01", repeat: { kind: "monthly", days: [1, 15] } });
  it("下月 1 号发生", () => expect(occursOn(t, "2026-07-01")).toBe(true));
  it("下月 15 号发生", () => expect(occursOn(t, "2026-07-15")).toBe(true));
  it("16 号不发生", () => expect(occursOn(t, "2026-07-16")).toBe(false));

  it("每月 31 号遇到 2 月 → 跳过本次，不挪到月末", () => {
    const m31 = todo({ title: "月底对账", date: "2026-01-31", repeat: { kind: "monthly", days: [31] } });
    expect(occursOn(m31, "2026-02-28")).toBe(false);
    expect(occursOn(m31, "2026-03-31")).toBe(true);
  });
  it("每月 30 号遇到 2 月 → 同样跳过", () => {
    const m30 = todo({ title: "对账", date: "2026-01-30", repeat: { kind: "monthly", days: [30] } });
    expect(occursOn(m30, "2026-02-28")).toBe(false);
    expect(occursOn(m30, "2026-04-30")).toBe(true);
  });
});

describe("随笔永远不重复", () => {
  it("日期为 null 时任何规则都不发生", () => {
    const t = todo({ title: "灵感", repeat: { kind: "daily" } });
    expect(occursOn(t, MON)).toBe(false);
    expect(occursOn(t, "2026-06-14")).toBe(false);
  });
});

describe("规则规范化", () => {
  it("周几去重并排序", () => {
    expect(normalizeRepeatRule({ kind: "weekly", weekdays: [3, 1, 3, 7] })).toEqual({
      kind: "weekly",
      weekdays: [1, 3, 7],
    });
  });
  it("月日过滤非法值（0 / 32 不存在）", () => {
    expect(normalizeRepeatRule({ kind: "monthly", days: [0, 5, 40, 5, 31] })).toEqual({
      kind: "monthly",
      days: [5, 31],
    });
  });
  it("空集合退化成不重复", () => {
    expect(normalizeRepeatRule({ kind: "weekly", weekdays: [] })).toEqual({ kind: "none" });
    expect(normalizeRepeatRule({ kind: "monthly", days: [] })).toEqual({ kind: "none" });
  });
});

describe("区间查询与下一次", () => {
  const weekly = todo({ title: "每周一", date: MON, repeat: { kind: "weekly", weekdays: [1] } });

  it("occurrencesBetween 闭区间", () => {
    expect(occurrencesBetween(weekly, "2026-06-15", "2026-07-06")).toEqual([
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
      "2026-07-06",
    ]);
  });
  it("起止倒置返回空", () => {
    expect(occurrencesBetween(weekly, "2026-07-06", "2026-06-15")).toEqual([]);
  });
  it("nextOccurrenceOnOrAfter", () => {
    expect(nextOccurrenceOnOrAfter(weekly, "2026-06-16")).toBe("2026-06-22");
  });
  it("当天就发生则返回当天", () => {
    expect(nextOccurrenceOnOrAfter(weekly, "2026-06-15")).toBe("2026-06-15");
  });
  it("限定天数内没有则返回 null", () => {
    const rare = todo({ title: "年货", date: "2026-01-01", repeat: { kind: "monthly", days: [31] } });
    // 从 2 月 1 日起 30 天内没有 31 号之前……用一个月内无 31 号来构造
    expect(nextOccurrenceOnOrAfter(rare, "2026-02-01", 20)).toBeNull();
  });
});

describe("规则文案", () => {
  it("不重复", () => expect(describeRepeat({ kind: "none" })).toBe("不重复"));
  it("每天", () => expect(describeRepeat({ kind: "daily" })).toBe("每天"));
  it("工作日", () => expect(describeRepeat({ kind: "weekdays" })).toBe("工作日"));
  it("每周", () => expect(describeRepeat({ kind: "weekly", weekdays: [1, 3] })).toBe("每周一、三"));
  it("每周七天说成每天", () =>
    expect(describeRepeat({ kind: "weekly", weekdays: [1, 2, 3, 4, 5, 6, 7] })).toBe("每天"));
  it("每月", () => expect(describeRepeat({ kind: "monthly", days: [1, 15] })).toBe("每月 1、15 号"));
});
