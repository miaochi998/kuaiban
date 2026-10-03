import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_TIME, shouldSummarize, summaryText } from "../src/lib/morning-summary";

const DAY = "2026-10-03";

function check(over: Partial<Parameters<typeof shouldSummarize>[0]> = {}) {
  return shouldSummarize({
    allDayCount: 3,
    businessDate: DAY,
    now: new Date("2026-10-03T10:00:00"),
    summaryTime: DEFAULT_SUMMARY_TIME,
    lastSummarizedDay: null,
    ...over,
  });
}

describe("什么时候该汇总", () => {
  it("过了汇总时刻、有事、今天还没汇总过 → 汇总", () => {
    expect(check()).toBe(true);
  });

  it("还没到汇总时刻 → 不汇总", () => {
    expect(check({ now: new Date("2026-10-03T08:59:00") })).toBe(false);
  });

  it("正好到点 → 汇总", () => {
    expect(check({ now: new Date("2026-10-03T09:00:00") })).toBe(true);
  });

  it("今天已经汇总过 → 不再汇总（一天只提醒一次）", () => {
    expect(check({ lastSummarizedDay: DAY })).toBe(false);
  });

  it("昨天汇总过、今天还没 → 照常汇总", () => {
    expect(check({ lastSummarizedDay: "2026-10-02" })).toBe(true);
  });

  it("没有没定时间的事 → 不打扰", () => {
    expect(check({ allDayCount: 0 })).toBe(false);
  });

  it("非法时刻 → 不汇总（不猜）", () => {
    expect(check({ summaryTime: "25:00" })).toBe(false);
    expect(check({ summaryTime: "" })).toBe(false);
  });

  it("可以自定义汇总时刻", () => {
    const early = { summaryTime: "07:30" as const };
    expect(check({ ...early, now: new Date("2026-10-03T07:31:00") })).toBe(true);
    expect(check({ ...early, now: new Date("2026-10-03T07:29:00") })).toBe(false);
  });

  it("跨业务日：凌晨 3 点仍算前一天，不会误触发当天的汇总", () => {
    // 业务日 10-02，汇总时刻 10-02 09:00 —— 早已过去，所以会触发；
    // 但 lastSummarizedDay 记录的也应是 10-02，一天仍然只汇总一次
    const at3am = new Date("2026-10-03T03:00:00");
    expect(
      shouldSummarize({
        allDayCount: 2,
        businessDate: "2026-10-02",
        now: at3am,
        summaryTime: DEFAULT_SUMMARY_TIME,
        lastSummarizedDay: null,
      }),
    ).toBe(true);
  });
});

describe("文案", () => {
  it("说清有几件", () => {
    expect(summaryText(5)).toContain("5");
    expect(summaryText(5)).toContain("没定时间");
  });

  it("足够短，放得下一行", () => {
    expect(summaryText(12).length).toBeLessThanOrEqual(20);
  });
});
