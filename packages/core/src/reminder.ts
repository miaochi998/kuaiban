/**
 * 提醒引擎（纯逻辑，不含计时器）
 *
 * 分工：
 * - **大脑（本文件）**：算出"此刻该触发哪些提醒"，以及免打扰、合并规则。
 * - **外壳**：负责真正的定时器、闪动、声音、气泡。它每隔一小段时间问一次大脑。
 *
 * 这样把"什么时候该响"和"怎么响"彻底分开 —— 后者全是平台相关的。
 */

import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  type DateKey,
  type TimeOfDay,
  type Todo,
} from "@kuaiban/shared";
import { atTimeOnDate, businessDateKey, parseTimeOfDay } from "./date";
import { occursOn } from "./repeat";
import { isAlive, isOccurrencePending } from "./todo";

/** L1 闪动+响一声之后，多久升级到 L2 弹气泡（业务逻辑文档 §6.2） */
export const ESCALATE_AFTER_MS = 60_000;

/** 挂件轮询提醒的间隔建议值 */
export const REMINDER_POLL_MS = 15_000;

export interface DueReminder {
  todo: Todo;
  /** 这次提醒对应的是哪个业务日的发生 */
  occurrenceDate: DateKey;
  /** 理论上应该在什么时刻响 */
  fireAt: Date;
  /** 唯一标识：`待办id@业务日`。推后 / 今天不再提醒 / 已升级气泡 都按它记账 */
  key: string;
}

/** 同一条待办同一天的唯一标识 */
export function reminderKey(todoId: string, dateKey: DateKey): string {
  return `${todoId}@${dateKey}`;
}

/**
 * 某条待办在某天的**提醒时刻**。
 * 没设提醒、或没有具体时间的（全天事项）→ null。
 */
export function fireAtFor(todo: Todo, dateKey: DateKey): Date | null {
  if (!todo.remind) return null;
  if (todo.time === null) return null; // 全天事项不逐条提醒，走"早上汇总"
  const at = atTimeOnDate(dateKey, todo.time);
  if (!at) return null;
  const before = Number.isFinite(todo.remindBefore) ? todo.remindBefore : 0;
  return new Date(at.getTime() - before * 60_000);
}

export interface DueOptions {
  /** 业务日分界小时，默认 04:00 */
  boundaryHour?: number;
}

/**
 * 当前**所有**「已经到点、还没处理」的提醒。
 *
 * ## 为什么是"所有"，而不是"某个时间窗内新到点的"
 *
 * 时间窗方案（"上次检查到现在之间新到点的"）依赖调用间隔：软件睡了、卡了、
 * 被关掉再打开，窗口就错开了，**会漏**。而这个函数每次都是重新算一遍
 * "到现在为止还有哪些没处理"，与调用间隔无关。
 *
 * 提醒队列因此可以很简单：每次重算候选，减去"已处理的"（完成 / 推后 / 今天不再提醒），
 * 结果永远正确，不需要维护脆弱的增量状态。
 *
 * ## 为什么只看当前业务日
 *
 * 一开始回看了"昨天 + 今天"，结果**每日任务昨天那次也跟着响**（一天响两遍），
 * 而且昨天没做完的一次性事项早就进了「昨日未完成」区用视觉呈现了，
 * 再用响铃重复打扰纯属噪音 —— 那正是这个软件要消灭的东西。
 *
 * 跨午夜不是问题：业务日的分界是凌晨 04:00，所以 00:00–04:00 的提醒
 * 本来就属于"当前业务日"（`businessDateKey` 会把凌晨算作前一天）。
 *
 * 唯一会漏的场景：软件在 23:00–04:00 之间完全没开 —— 那条提醒不会响，
 * 但事项仍会出现在「昨日未完成」里，不会丢。
 */
export function dueReminders(
  todos: Todo[],
  now: Date,
  opts: DueOptions = {},
): DueReminder[] {
  const boundaryHour = opts.boundaryHour ?? DEFAULT_DAY_BOUNDARY_HOUR;
  const today = businessDateKey(now, boundaryHour);
  const nowMs = now.getTime();

  const out: DueReminder[] = [];
  for (const todo of todos) {
    if (!isAlive(todo)) continue;
    if (!occursOn(todo, today)) continue;
    if (!isOccurrencePending(todo, today)) continue;

    const fireAt = fireAtFor(todo, today);
    if (!fireAt) continue;
    if (fireAt.getTime() > nowMs) continue; // 还没到点

    out.push({ todo, occurrenceDate: today, fireAt, key: reminderKey(todo.id, today) });
  }

  // 到点越久的排越前面 —— 最该被处理的先被看到
  out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return out;
}

/**
 * 这条提醒是不是"错过太久了"（软件没开着 / 电脑睡了很久）。
 *
 * 用途：重新打开软件时，把这种老提醒标注出来，让人一眼看出
 * "这不是刚刚到点的，是我错过的那批"（业务逻辑文档 §6.2）。
 */
export const MISSED_AFTER_MS = 10 * 60_000;

export function isMissedReminder(item: DueReminder, now: Date): boolean {
  return now.getTime() - item.fireAt.getTime() > MISSED_AFTER_MS;
}

// ─────────────────────────────────────────────────────────────
// 提醒风暴合并 —— 这是生死线
// ─────────────────────────────────────────────────────────────

export interface ReminderBatch {
  items: DueReminder[];
  count: number;
  /** 是否需要"合并成一条"呈现（多件事同时到点） */
  merged: boolean;
  /** 合并时给用户看的一句话 */
  headline: string;
  /** 合并时列出的前几条内容 */
  preview: string[];
}

/**
 * 同一时刻多件事到点 → **合并成一条提醒**。
 *
 * 业务逻辑文档把它列为"生死线"：周一早上 10 件事同时到点，
 * 如果弹 10 个窗口，用户第一天就会把软件卸掉。
 */
export function batchReminders(items: DueReminder[]): ReminderBatch {
  const count = items.length;
  if (count === 0) {
    return { items: [], count: 0, merged: false, headline: "没有到点的事", preview: [] };
  }
  if (count === 1) {
    const only = items[0] as DueReminder;
    return { items, count: 1, merged: false, headline: only.todo.title, preview: [] };
  }
  return {
    items,
    count,
    merged: true,
    headline: `你有 ${count} 件事到点了`,
    preview: items.slice(0, 4).map((r) => r.todo.title),
  };
}

// ─────────────────────────────────────────────────────────────
// 全天事项（没设时间的）—— 只在早上汇总一次，不逐条打扰
// ─────────────────────────────────────────────────────────────

/** 某天所有"全天"且还没做的待办 */
export function allDayTodosOn(todos: Todo[], dateKey: DateKey): Todo[] {
  return todos.filter(
    (t) => isAlive(t) && t.time === null && occursOn(t, dateKey) && isOccurrencePending(t, dateKey),
  );
}

// ─────────────────────────────────────────────────────────────
// 免打扰
// ─────────────────────────────────────────────────────────────

export interface QuietHours {
  enabled: boolean;
  /** `HH:mm`，如 "22:00" */
  start: TimeOfDay;
  /** `HH:mm`，如 "07:00" */
  end: TimeOfDay;
}

/** 默认 22:00–07:00 免打扰：只闪图标，不响声音、不弹气泡 */
export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  start: "22:00",
  end: "07:00",
};

/**
 * 某个时刻是否处于免打扰。
 * 支持跨越午夜的区间（如 22:00–07:00）。
 */
export function isQuietTime(at: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const s = parseTimeOfDay(quiet.start);
  const e = parseTimeOfDay(quiet.end);
  if (!s || !e) return false;

  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = s.hour * 60 + s.minute;
  const end = e.hour * 60 + e.minute;

  if (start === end) return false; // 区间为空
  if (start < end) return minutes >= start && minutes < end;
  // 跨午夜
  return minutes >= start || minutes < end;
}

/** 免打扰结束后第一个可提醒的时刻（用于把夜间到点的提醒挪到早上） */
export function quietHoursEndAt(at: Date, quiet: QuietHours): Date {
  const e = parseTimeOfDay(quiet.end);
  if (!e) return at;
  const d = new Date(at);
  d.setHours(e.hour, e.minute, 0, 0);
  if (d.getTime() <= at.getTime()) d.setDate(d.getDate() + 1);
  return d;
}
