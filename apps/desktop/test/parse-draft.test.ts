import { describe, expect, it } from "vitest";
import { parseDraft } from "../src/lib/parse-draft";

describe("极速捕获：输入框里直接写时间", () => {
  it("标准写法", () => {
    expect(parseDraft("9:30 交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("全角冒号（中文输入法下太常见了）", () => {
    expect(parseDraft("09：30 交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("全角冒号 + 省略前导零", () => {
    expect(parseDraft("9：30 交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("不带空格", () => {
    expect(parseDraft("9:30交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("跟中文逗号", () => {
    expect(parseDraft("9:30，交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("跟顿号", () => {
    expect(parseDraft("9:30、交周报")).toEqual({ title: "交周报", time: "09:30" });
  });

  it("分钟不补零也认", () => {
    expect(parseDraft("9:5 开会")).toEqual({ title: "开会", time: "09:05" });
  });

  it("边界时刻", () => {
    expect(parseDraft("00:00 睡觉")).toEqual({ title: "睡觉", time: "00:00" });
    expect(parseDraft("23:59 关电脑")).toEqual({ title: "关电脑", time: "23:59" });
  });

  it("内容里的空格会保留（只去掉首尾）", () => {
    expect(parseDraft("9:30 给 张总 回电话")).toEqual({
      title: "给 张总 回电话",
      time: "09:30",
    });
  });

  it("首尾空白被忽略", () => {
    expect(parseDraft("   9:30 交周报   ")).toEqual({ title: "交周报", time: "09:30" });
  });
});

describe("不瞎猜的情况（宁可不当成时间）", () => {
  it("光秃秃一个时间 → 当成标题", () => {
    expect(parseDraft("9:30")).toEqual({ title: "9:30", time: null });
  });

  it("非法时刻 → 整体当标题", () => {
    expect(parseDraft("25:00 开会")).toEqual({ title: "25:00 开会", time: null });
    expect(parseDraft("9:70 开会")).toEqual({ title: "9:70 开会", time: null });
  });

  it("时间在中间或结尾 → 不解析（避免误判内容里的数字）", () => {
    expect(parseDraft("交周报 9:30")).toEqual({ title: "交周报 9:30", time: null });
    expect(parseDraft("订 3 个会议室")).toEqual({ title: "订 3 个会议室", time: null });
  });

  it("普通内容", () => {
    expect(parseDraft("买咖啡豆")).toEqual({ title: "买咖啡豆", time: null });
  });

  it("空输入", () => {
    expect(parseDraft("")).toEqual({ title: "", time: null });
    expect(parseDraft("    ")).toEqual({ title: "", time: null });
  });

  it("三位数不像时间", () => {
    expect(parseDraft("100:30 开会")).toEqual({ title: "100:30 开会", time: null });
  });
});
