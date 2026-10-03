import { describe, expect, it } from "vitest";
import type { RepeatRule, TimeOfDay } from "@kuaiban/core";
import { parseDraft } from "../src/lib/parse-draft";

const NONE: RepeatRule = { kind: "none" };
const daily: RepeatRule = { kind: "daily" };
const weekdaysRule: RepeatRule = { kind: "weekdays" };
const weekly = (...days: number[]): RepeatRule => ({
  kind: "weekly",
  weekdays: days as (1 | 2 | 3 | 4 | 5 | 6 | 7)[],
});
const monthly = (...days: number[]): RepeatRule => ({ kind: "monthly", days });

/** 断言「内容 + 时间」，默认不重复 */
function expectTime(raw: string, title: string, time: TimeOfDay | null, repeat: RepeatRule = NONE) {
  expect(parseDraft(raw)).toEqual({ title, time, repeat });
}

/** 断言「内容 + 重复」，默认无时间 */
function expectRepeat(raw: string, title: string, repeat: RepeatRule) {
  expect(parseDraft(raw)).toEqual({ title, time: null, repeat });
}

// ─────────────────────────────────────────────────────────────
// 原有行为：冒号式时间（这 10 条是回归基线，不能退化）
// ─────────────────────────────────────────────────────────────

describe("时间·冒号式", () => {
  it("标准写法", () => expectTime("9:30 交周报", "交周报", "09:30"));

  it("全角冒号（中文输入法下太常见了）", () =>
    expectTime("09：30 交周报", "交周报", "09:30"));

  it("全角冒号 + 省略前导零", () => expectTime("9：30 交周报", "交周报", "09:30"));

  it("不带空格", () => expectTime("9:30交周报", "交周报", "09:30"));

  it("跟中文逗号", () => expectTime("9:30，交周报", "交周报", "09:30"));

  it("跟顿号", () => expectTime("9:30、交周报", "交周报", "09:30"));

  it("分钟不补零也认", () => expectTime("9:5 开会", "开会", "09:05"));

  it("边界时刻", () => {
    expectTime("00:00 睡觉", "睡觉", "00:00");
    expectTime("23:59 关电脑", "关电脑", "23:59");
  });

  it("内容里的空格会保留（只去掉首尾）", () =>
    expectTime("9:30 给 张总 回电话", "给 张总 回电话", "09:30"));

  it("首尾空白被忽略", () => expectTime("   9:30 交周报   ", "交周报", "09:30"));
});

// ─────────────────────────────────────────────────────────────
// 新增：中文时间写法
// ─────────────────────────────────────────────────────────────

describe("时间·中文式（点 / 点半 / 点分）", () => {
  it("9点", () => expectTime("9点 开会", "开会", "09:00"));

  it("9点半", () => expectTime("9点半 开会", "开会", "09:30"));

  it("9点30", () => expectTime("9点30 开会", "开会", "09:30"));

  it("9点30分", () => expectTime("9点30分 开会", "开会", "09:30"));

  it("不补零的分钟", () => expectTime("9点5分 开会", "开会", "09:05"));

  it("不空格直接接内容", () => expectTime("9点开会", "开会", "09:00"));
  it("不空格 + 分钟", () => expectTime("9点30开会", "开会", "09:30"));

  it("边界：0点 / 23点", () => {
    expectTime("0点 睡觉", "睡觉", "00:00");
    expectTime("23点 关电脑", "关电脑", "23:00");
  });

  it("非法小时不认（整串当标题）", () => {
    expectTime("25点 开会", "25点 开会", null);
    expectTime("99点 开会", "99点 开会", null);
  });
});

describe("时间·时段词", () => {
  it("上午 / 早上 / 凌晨：小时保持原样", () => {
    expectTime("上午9点 开会", "开会", "09:00");
    expectTime("早上7点半 跑步", "跑步", "07:30");
    expectTime("凌晨1点 值班", "值班", "01:00");
  });

  it("中午：1–6 点算下午，11/12 点保持", () => {
    expectTime("中午12点 吃饭", "吃饭", "12:00");
    expectTime("中午1点 吃饭", "吃饭", "13:00");
    expectTime("中午11点半 吃饭", "吃饭", "11:30");
  });

  it("下午 / 傍晚：小于 12 点才加 12", () => {
    expectTime("下午2:30 去游泳", "去游泳", "14:30");
    expectTime("下午2点 去游泳", "去游泳", "14:00");
    expectTime("傍晚6点 下班", "下班", "18:00");
  });

  it("已经是 24 小时制就不再加减", () => {
    expectTime("下午14:30 开会", "开会", "14:30");
    expectTime("晚上20点 加班", "加班", "20:00");
  });

  it("晚上：小于 12 点加 12；12 点是午夜", () => {
    expectTime("晚上8点 看剧", "看剧", "20:00");
    expectTime("晚上8:30 看剧", "看剧", "20:30");
    expectTime("晚上12点 睡觉", "睡觉", "00:00");
  });

  it("时段词 + 全角冒号 + 不空格（用户原话）", () => {
    expectTime("下午2：30去游泳", "去游泳", "14:30");
  });
});

// ─────────────────────────────────────────────────────────────
// 新增：重复规则
// ─────────────────────────────────────────────────────────────

describe("重复·每天", () => {
  it("每天", () => expectRepeat("每天 吃药", "吃药", daily));
  it("每日", () => expectRepeat("每日 汇报", "汇报", daily));
  it("不空格直接接内容（中文没有词边界，用户就是这么写）", () =>
    expectRepeat("每天吃苹果", "吃苹果", daily));
});

describe("重复·工作日", () => {
  it("工作日", () => expectRepeat("工作日 打卡", "打卡", weekdaysRule));
  it("每个工作日", () => expectRepeat("每个工作日 打卡", "打卡", weekdaysRule));
  it("带逗号分隔", () => expectRepeat("工作日，打卡", "打卡", weekdaysRule));
});

describe("重复·每周", () => {
  it("单个星期", () => expectRepeat("每周六 周会", "周会", weekly(6)));
  it("周日与周天都算 7", () => {
    expectRepeat("每周日 休息", "休息", weekly(7));
    expectRepeat("每周天 休息", "休息", weekly(7));
  });
  it("多个连写", () => expectRepeat("每周一三五 晨会", "晨会", weekly(1, 3, 5)));
  it("顿号分隔", () => expectRepeat("每周一、三、五 晨会", "晨会", weekly(1, 3, 5)));
  it("逗号分隔（半角与中文）", () => {
    expectRepeat("每周一,三 晨会", "晨会", weekly(1, 3));
    expectRepeat("每周一，三 晨会", "晨会", weekly(1, 3));
  });
  it("顿号两边带空格", () => expectRepeat("每周一 、 三 晨会", "晨会", weekly(1, 3)));
  it("不空格直接接内容", () => expectRepeat("每周六开会", "开会", weekly(6)));
  it("重复的星期会被去重排序（走大脑归一化）", () =>
    expectRepeat("每周三一三 晨会", "晨会", weekly(1, 3)));
});

describe("重复·每月", () => {
  it("每月N号", () => expectRepeat("每月15号 交房租", "交房租", monthly(15)));
  it("每月N日", () => expectRepeat("每月1日 交房租", "交房租", monthly(1)));
  it("不空格直接接内容", () => expectRepeat("每月15号交房租", "交房租", monthly(15)));
});

// ─────────────────────────────────────────────────────────────
// 新增：时间 + 重复 组合（顺序任意）
// ─────────────────────────────────────────────────────────────

describe("时间与重复组合", () => {
  it("重复在前", () =>
    expectTime("每天 9:30 吃药", "吃药", "09:30", daily));

  it("时间在前", () =>
    expectTime("9:30 每天 吃药", "吃药", "09:30", daily));

  it("两者都不带分隔符", () =>
    expectTime("每周六10:00开会", "开会", "10:00", weekly(6)));

  it("中文时间 + 重复", () =>
    expectTime("每天下午2点半 午休", "午休", "14:30", daily));

  it("时段词在后、重复在前", () =>
    expectTime("每月15号 下午3点 交材料", "交材料", "15:00", monthly(15)));

  it("工作日 + 时间", () =>
    expectTime("工作日 9:00 打卡", "打卡", "09:00", weekdaysRule));
});

// ─────────────────────────────────────────────────────────────
// 陷阱：这些**不该**被识别（比"该识别"更值钱）
// ─────────────────────────────────────────────────────────────

describe("陷阱·重复词撞上常用词", () => {
  it("「工作日志」不能被吃掉「工作日」", () =>
    expectTime("工作日志", "工作日志", null));

  it("「工作日报」同上", () => expectTime("工作日报", "工作日报", null));

  it("「工作人员」同上", () => expectTime("工作人员", "工作人员", null));

  it("但「工作日」后面真有分隔符时要认", () =>
    expectRepeat("工作日 写日志", "写日志", weekdaysRule));

  it("「每周例会」不认（每周后面必须是星期字）", () =>
    expectTime("每周例会", "每周例会", null));

  it("「每月报表」不认（每月后面必须有数字+号/日）", () =>
    expectTime("每月报表", "每月报表", null));

  it("「每月32号」不认（日期非法，整串当标题）", () =>
    expectTime("每月32号 团建", "每月32号 团建", null));

  it("「每月0号」不认", () => expectTime("每月0号 团建", "每月0号 团建", null));
});

describe("陷阱·时段词撞上常用词", () => {
  it("「下午茶」不是时间", () => expectTime("下午茶", "下午茶", null));
  it("「晚上睡觉」不是时间", () => expectTime("晚上睡觉", "晚上睡觉", null));
  it("「上午的会议」不是时间", () => expectTime("上午的会议", "上午的会议", null));
  it("「早上好」不是时间", () => expectTime("早上好", "早上好", null));
});

describe("陷阱·只认开头（原有约束不能破）", () => {
  it("时间在中间或结尾 → 不解析", () => {
    expectTime("交周报 9:30", "交周报 9:30", null);
    expectTime("订 3 个会议室", "订 3 个会议室", null);
  });

  it("重复词在中间 → 不解析", () => {
    expectTime("讨论每天例会安排", "讨论每天例会安排", null);
    expectTime("整理每周报表", "整理每周报表", null);
  });

  it("三位数不像时间", () => expectTime("100:30 开会", "100:30 开会", null));

  it("日期不会被当成时间", () => expectTime("2026-10-03 开会", "2026-10-03 开会", null));
});

describe("陷阱·只有前缀没有内容", () => {
  it("光秃秃一个时间 → 当成标题，不设时间", () => {
    expectTime("9:30", "9:30", null);
    expectTime("下午2点", "下午2点", null);
  });

  it("光秃秃一个重复词 → 当成标题，不设重复", () => {
    expectTime("每天", "每天", null);
    expectTime("每周六", "每周六", null);
  });

  it("时间和重复都有、就是没内容 → 整串当标题", () => {
    expectTime("每天 9:30", "每天 9:30", null);
    expectTime("9:30 每天", "9:30 每天", null);
  });
});

describe("陷阱·非法时刻", () => {
  it("25:00 / 9:70 → 整体当标题", () => {
    expectTime("25:00 开会", "25:00 开会", null);
    expectTime("9:70 开会", "9:70 开会", null);
  });

  it("非法时刻在前、重复词在后 → 时间不认、重复也不动（因为不在开头）", () => {
    expectTime("25:00 每天 开会", "25:00 每天 开会", null);
  });
});

describe("陷阱·不抛异常", () => {
  const weird = [
    "",
    "   ",
    ":",
    "：",
    "点",
    "半",
    "每周",
    "每月",
    "每月号",
    "9点60分",
    "24点",
    "下午25点",
    "晚上99点",
    "每周一二三四五六日天",
    "每天每天每天",
    "((((",
    "🔥🔥🔥",
  ];

  it.each(weird)("输入 %j 有确定结果且不抛错", (raw) => {
    expect(() => parseDraft(raw)).not.toThrow();
    const parsed = parseDraft(raw);
    expect(typeof parsed.title).toBe("string");
    expect(parsed.time === null || /^\d{2}:\d{2}$/.test(parsed.time)).toBe(true);
  });

  it("空输入", () => {
    expect(parseDraft("")).toEqual({ title: "", time: null, repeat: NONE });
    expect(parseDraft("    ")).toEqual({ title: "", time: null, repeat: NONE });
  });
});

// ─────────────────────────────────────────────────────────────
// 已知歧义：文档化，不假装它不存在
// ─────────────────────────────────────────────────────────────

describe("已知歧义（按规格实现，但值得知道）", () => {
  it("「每周一次大扫除」不会误读成「每周一」", () => {
    // 「每周一」后面紧跟量词（次/个/遍/场/趟/回）时，"每一周…一次"才是真意。
    // 此时整串当内容 —— 宁可识别不出重复（用户能在编辑面板补），
    // 也不能凭空生成"每周一"这种错数据。
    expectTime("每周一次大扫除", "每周一次大扫除", null);
    expectTime("每周一遍", "每周一遍", null);
  });

  it("但「每周一开会」照常识别（后面是内容，不是量词）", () => {
    expectRepeat("每周一开会", "开会", weekly(1));
  });

  it("「上午12点」= 正午 12:00；但「凌晨12点」= 午夜 00:00", () => {
    // 两者看起来矛盾，其实符合各自语感：「上午12点」是"正午"的常见说法，
    // 而"凌晨"本身就是深夜，「凌晨12点」只可能指午夜。
    expectTime("上午12点 站会", "站会", "12:00");
    expectTime("凌晨12点 睡觉", "睡觉", "00:00");
    // 需要明确午夜时这两个写法是对的：
    expectTime("晚上12点 睡觉", "睡觉", "00:00");
    expectTime("00:00 睡觉", "睡觉", "00:00");
  });
});
