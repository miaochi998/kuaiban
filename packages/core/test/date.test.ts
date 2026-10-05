import { describe, expect, it } from "vitest";
import {
  addDays,
  atTimeOnDate,
  businessDateKey,
  diffDays,
  fromDateKey,
  isWeekend,
  isoWeekday,
  normalizeTimeOfDay,
  parseTimeOfDay,
  toDateKey,
  toTimeOfDay,
} from "../src";

describe("业务日：凌晨 04:00 分界", () => {
  it("03:59 仍然算前一天", () => {
    expect(businessDateKey(new Date("2026-06-15T03:59:00"))).toBe("2026-06-14");
  });
  it("04:00 起算当天", () => {
    expect(businessDateKey(new Date("2026-06-15T04:00:00"))).toBe("2026-06-15");
  });
  it("白天与深夜都算当天", () => {
    expect(businessDateKey(new Date("2026-06-15T09:00:00"))).toBe("2026-06-15");
    expect(businessDateKey(new Date("2026-06-15T23:59:00"))).toBe("2026-06-15");
  });
  it("分界小时可配置", () => {
    expect(businessDateKey(new Date("2026-06-15T05:00:00"), 6)).toBe("2026-06-14");
    expect(businessDateKey(new Date("2026-06-15T06:00:00"), 6)).toBe("2026-06-15");
  });
});

describe("日期加减", () => {
  it("同月", () => expect(addDays("2026-06-15", 1)).toBe("2026-06-16"));
  it("跨月", () => expect(addDays("2026-06-30", 1)).toBe("2026-07-01"));
  it("跨年", () => expect(addDays("2026-12-31", 1)).toBe("2027-01-01"));
  it("向前跨年", () => expect(addDays("2027-01-01", -1)).toBe("2026-12-31"));
  it("加 0 不变", () => expect(addDays("2026-06-15", 0)).toBe("2026-06-15"));
});

describe("天数差", () => {
  it("同月", () => expect(diffDays("2026-06-15", "2026-06-21")).toBe(6));
  it("跨月", () => expect(diffDays("2026-06-30", "2026-07-02")).toBe(2));
  it("跨年", () => expect(diffDays("2026-12-31", "2027-01-01")).toBe(1));
  it("负数", () => expect(diffDays("2026-06-21", "2026-06-15")).toBe(-6));
  it("与 addDays 互逆", () => {
    for (const n of [-400, -31, -1, 0, 1, 30, 365]) {
      expect(diffDays("2026-06-15", addDays("2026-06-15", n))).toBe(n);
    }
  });
});

describe("往返与校验", () => {
  it("toDateKey / fromDateKey 往返", () => {
    expect(toDateKey(fromDateKey("2026-06-15"))).toBe("2026-06-15");
  });
  it("拒绝不存在的日期（宁可早失败，不要静默算错）", () => {
    expect(() => fromDateKey("2026-02-30")).toThrow();
    expect(() => fromDateKey("2026-13-01")).toThrow();
  });
  it("拒绝格式错误", () => {
    expect(() => fromDateKey("2026/06/15")).toThrow();
    expect(() => fromDateKey("")).toThrow();
  });
});

describe("星期", () => {
  it("周一 = 1", () => expect(isoWeekday("2026-06-15")).toBe(1));
  it("周日 = 7", () => expect(isoWeekday("2026-06-21")).toBe(7));
  it("周末判定", () => {
    expect(isWeekend("2026-06-19")).toBe(false);
    expect(isWeekend("2026-06-20")).toBe(true);
    expect(isWeekend("2026-06-21")).toBe(true);
  });
});

describe("时刻", () => {
  it("解析合法时刻", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
  });
  it("拒绝非法时刻", () => {
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9:30")).toBeNull();
    expect(parseTimeOfDay("09:60")).toBeNull();
    expect(parseTimeOfDay("")).toBeNull();
  });
  it("宽松规范化（用户手输）", () => {
    expect(normalizeTimeOfDay("9:5")).toBe("09:05");
    expect(normalizeTimeOfDay(" 14:00 ")).toBe("14:00");
    expect(normalizeTimeOfDay("25:00")).toBeNull();
    expect(normalizeTimeOfDay("abc")).toBeNull();
  });
  it("atTimeOnDate 落在正确的日子", () => {
    const d = atTimeOnDate("2026-06-15", "14:00");
    expect(d).not.toBeNull();
    expect(d!.getHours()).toBe(14);
    expect(d!.getMinutes()).toBe(0);
    expect(toDateKey(d!)).toBe("2026-06-15");
  });
  it("atTimeOnDate 对非法时刻返回 null", () => {
    expect(atTimeOnDate("2026-06-15", "99:99")).toBeNull();
  });
  it("toTimeOfDay 补零", () => {
    expect(toTimeOfDay(new Date("2026-06-15T08:05:00"))).toBe("08:05");
    expect(toTimeOfDay(new Date("2026-06-15T00:00:00"))).toBe("00:00");
  });
});

describe("时间里的中文标点要能认", () => {
  it("全角冒号「：」等价于半角「:」", () => {
    // 中文输入法下打出的就是这个，用户看着和半角没区别
    expect(normalizeTimeOfDay("16：30")).toBe("16:30");
    expect(normalizeTimeOfDay("9：5")).toBe("09:05");
  });

  it("中间夹空格也认", () => {
    expect(normalizeTimeOfDay(" 9 : 30 ")).toBe("09:30");
  });

  it("非法输入照旧返回 null（别放宽过头）", () => {
    expect(normalizeTimeOfDay("25:00")).toBeNull();
    expect(normalizeTimeOfDay("abc")).toBeNull();
    expect(normalizeTimeOfDay("")).toBeNull();
  });
});
