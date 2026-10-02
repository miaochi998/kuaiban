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
import { addDays, atTimeOnDate, businessDateKey, parseTimeOfDay } from "./date";
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

export interface CollectOptions {
  /** 业务日分界小时，默认 04:00 */
  boundaryHour?: number;
  /** 免打扰时段；命中的提醒会被推迟到免打扰结束后（返回时被过滤掉） */
  quietHours?: QuietHours;
}

/**
 * 收集在 `(since, now]` 这段时间里"本该响"的提醒。
 *
 * 调用方式：外壳每 15 秒调一次，`since` 传上次调用的时刻。
 * 用**时间窗**而不是"等于此刻"，是为了让睡眠 / 卡顿 / 短暂挂起后不会漏提醒。
 * 真正的"漏了很久"由外壳汇总成一条"你错过了 N 个提醒"（业务逻辑文档 §6.2）。
 *
 * 只回看昨天和今天两天：更早的一次性待办已经进了「昨日未完成」区，
 * 不该再重复响（那正是这个软件要避免的噪音）。
 */
export function collectDueReminders(
  todos: Todo[],
  now: Date,
  since: Date,
  opts: CollectOptions = {},
): DueReminder[] {
  const boundaryHour = opts.boundaryHour ?? DEFAULT_DAY_BOUNDARY_HOUR;
  const today = businessDateKey(now, boundaryHour);
  const days: DateKey[] = [addDays(today, -1), today];

  const nowMs = now.getTime();
  const sinceMs = since.getTime();
  const out: DueReminder[] = [];

  for (const todo of todos) {
    if (!isAlive(todo)) continue;

    for (const day of days) {
      if (!occursOn(todo, day)) continue;
      if (!isOccurrencePending(todo, day)) continue;

      const fireAt = fireAtFor(todo, day);
      if (!fireAt) continue;

      const ms = fireAt.getTime();
      if (ms > sinceMs && ms <= nowMs) {
        out.push({ todo, occurrenceDate: day, fireAt });
      }
    }
  }

  out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());

  if (opts.quietHours?.enabled) {
    return out.filter((r) => !isQuietTime(r.fireAt, opts.quietHours as QuietHours));
  }
  return out;
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
