/**
 * 重复规则（纯函数）
 *
 * 核心设计：**不预先造出几百条记录**，而是"用到时才问一句：这条规则在这一天有发生吗？"
 * 好处是性能恒定、不会因为定了"每天"就写坏数据库（业务逻辑文档 §6.3）。
 *
 * 第一版只支持 5 种规则，刻意不做"每 N 天""每月第几个周几"——简单是产品要求。
 */

import type { DateKey, IsoWeekday, RepeatRule, Todo } from "@kuaiban/shared";
import { addDays, compareDateKeys, dayOfMonth, daysInMonth, fromDateKey, isoWeekday } from "./date";

/** 规则是否等价于"不重复" */
export function isRepeating(todo: Todo): boolean {
  return todo.repeat.kind !== "none";
}

/**
 * 规范化规则：去重、排序、收敛非法值。
 * 界面传来的东西不可信，进大脑前先归一化。
 */
export function normalizeRepeatRule(rule: RepeatRule): RepeatRule {
  switch (rule.kind) {
    case "none":
    case "daily":
    case "weekdays":
      return { kind: rule.kind };
    case "weekly": {
      const set = new Set<number>();
      for (const d of rule.weekdays) {
        if (Number.isInteger(d) && d >= 1 && d <= 7) set.add(d);
      }
      const weekdays = [...set].sort((a, b) => a - b) as IsoWeekday[];
      // 一周一天都没选 = 没有意义，退化成不重复
      return weekdays.length === 0 ? { kind: "none" } : { kind: "weekly", weekdays };
    }
    case "monthly": {
      const set = new Set<number>();
      for (const d of rule.days) {
        if (Number.isInteger(d) && d >= 1 && d <= 31) set.add(d);
      }
      const days = [...set].sort((a, b) => a - b);
      return days.length === 0 ? { kind: "none" } : { kind: "monthly", days };
    }
  }
}

/**
 * 这条待办在某个业务日**是否有发生**。
 *
 * 语义细节：
 * - `date === null`（随笔）永远不重复
 * - 重复从 `date`（起始日）当天开始，之前不发生
 * - `monthly` 里"每月 31 号"遇到只有 30 天的月份 → **本次跳过**，不挪到月末。
 *   理由：用户说的是"31 号"，替他挪到 30 号反而会造成误解。
 * - 非重复待办：只有 `date === dateKey` 当天发生
 */
export function occursOn(todo: Todo, dateKey: DateKey): boolean {
  if (todo.date === null) return false;
  // 还没开始（字符串比较对 YYYY-MM-DD 成立）
  if (compareDateKeys(todo.date, dateKey) > 0) return false;

  switch (todo.repeat.kind) {
    case "none":
      return todo.date === dateKey;
    case "daily":
      return true;
    case "weekdays":
      return isoWeekday(dateKey) <= 5;
    case "weekly":
      return todo.repeat.weekdays.includes(isoWeekday(dateKey));
    case "monthly": {
      const dom = dayOfMonth(dateKey);
      if (!todo.repeat.days.includes(dom)) return false;
      // 防御：2 月 30/31 这类不存在的日期，Date 会自动溢出到下月，必须显式挡掉
      const d = fromDateKey(dateKey);
      return daysInMonth(d.getFullYear(), d.getMonth() + 1) >= dom;
    }
  }
}

/**
 * 列出 `[fromKey, toKey]` 闭区间内所有发生的业务日。
 * 用于日历视图按月取数。区间过大时由调用方负责限制。
 */
export function occurrencesBetween(
  todo: Todo,
  fromKey: DateKey,
  toKey: DateKey,
): DateKey[] {
  const out: DateKey[] = [];
  if (compareDateKeys(fromKey, toKey) > 0) return out;

  let cursor = fromKey;
  // 保险丝：最多扫 5 年，防止调用方传进来一个荒谬的区间把主线程卡死
  for (let i = 0; i < 366 * 5 && compareDateKeys(cursor, toKey) <= 0; i++) {
    if (occursOn(todo, cursor)) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** 从 `fromKey` 起（含）第一次发生的日子；`limitDays` 天内没有则返回 null */
export function nextOccurrenceOnOrAfter(
  todo: Todo,
  fromKey: DateKey,
  limitDays = 366,
): DateKey | null {
  let cursor = fromKey;
  for (let i = 0; i <= limitDays; i++) {
    if (occursOn(todo, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return null;
}

/** 人类可读的规则描述，如「每周一、三」「每月 1、15 号」 */
export function describeRepeat(rule: RepeatRule): string {
  const WD = ["一", "二", "三", "四", "五", "六", "日"];
  switch (rule.kind) {
    case "none":
      return "不重复";
    case "daily":
      return "每天";
    case "weekdays":
      return "工作日";
    case "weekly": {
      const names = rule.weekdays.map((d) => WD[d - 1] ?? "?").join("、");
      return rule.weekdays.length === 7 ? "每天" : `每周${names}`;
    }
    case "monthly": {
      const names = rule.days.join("、");
      return rule.days.length === 31 ? "每天" : `每月 ${names} 号`;
    }
  }
}
