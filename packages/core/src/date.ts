/**
 * 日期与时间工具（纯函数，无任何依赖）
 *
 * 设计要点：
 * - **业务日 ≠ 自然日**。业务日以凌晨 04:00 为界，见 `businessDateKey`。
 * - 全程使用**本地时区**。这是单机 / 局域网办公场景的桌面工具，不需要跨时区。
 * - 天数差一律用 UTC 正午做锚点计算，避开夏令时导致的 23 / 25 小时日。
 */

import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  type DateKey,
  type IsoWeekday,
  type TimeOfDay,
} from "@kuaiban/shared";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Date → `YYYY-MM-DD`（本地时区） */
export function toDateKey(d: Date): DateKey {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` → 本地零点。非法输入抛错（宁可早失败，也不要静默算错日期） */
export function fromDateKey(key: DateKey): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`非法的日期 key: ${JSON.stringify(key)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    throw new Error(`不存在的日期: ${key}`);
  }
  return d;
}

/** 加减天数。跨月 / 跨年 / 夏令时都由本地 Date 自动归一化 */
export function addDays(key: DateKey, days: number): DateKey {
  const d = fromDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

/**
 * `to - from` 的天数差（可为负）。
 *
 * 用 UTC 正午做锚点：直接相减本地零点，遇到夏令时切换日会得到 0.958 / 1.042 天，
 * 四舍五入虽然通常也对，但锚在正午是最稳的写法。
 */
export function diffDays(from: DateKey, to: DateKey): number {
  const a = fromDateKey(from);
  const b = fromDateKey(to);
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate(), 12);
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate(), 12);
  return Math.round((ub - ua) / 86_400_000);
}

/** ISO 星期：1 = 周一 …… 7 = 周日 */
export function isoWeekday(key: DateKey): IsoWeekday {
  const d = fromDateKey(key);
  const wd = d.getDay();
  return (wd === 0 ? 7 : wd) as IsoWeekday;
}

/** 该月的天数（1–12 月） */
export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

/** 当天是几号（1–31） */
export function dayOfMonth(key: DateKey): number {
  return fromDateKey(key).getDate();
}

/** 是否周末 */
export function isWeekend(key: DateKey): boolean {
  return isoWeekday(key) >= 6;
}

/**
 * 业务日 key —— 本项目的核心时间概念。
 *
 * 凌晨 `boundaryHour`（默认 04:00）之前，仍然算**前一天**。
 * 理由：用户熬夜到凌晨 1 点还在处理"今天"的事，日历不该已经翻页。
 */
export function businessDateKey(
  now: Date,
  boundaryHour: number = DEFAULT_DAY_BOUNDARY_HOUR,
): DateKey {
  const today = toDateKey(now);
  return now.getHours() < boundaryHour ? addDays(today, -1) : today;
}

/** 业务日的起始时刻（当天 04:00） */
export function startOfBusinessDay(
  key: DateKey,
  boundaryHour: number = DEFAULT_DAY_BOUNDARY_HOUR,
): Date {
  const d = fromDateKey(key);
  d.setHours(boundaryHour, 0, 0, 0);
  return d;
}

/** 字符序比较对 `YYYY-MM-DD` 天然成立 */
export function compareDateKeys(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
// 时刻
// ─────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:mm` → { hour, minute }；非法返回 null */
export function parseTimeOfDay(t: string): { hour: number; minute: number } | null {
  const m = TIME_RE.exec(t);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Date → `HH:mm` */
export function toTimeOfDay(d: Date): TimeOfDay {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 某个业务日的某个时刻。非法 `HH:mm` 返回 null */
export function atTimeOnDate(key: DateKey, time: TimeOfDay): Date | null {
  const parsed = parseTimeOfDay(time);
  if (!parsed) return null;
  const d = fromDateKey(key);
  d.setHours(parsed.hour, parsed.minute, 0, 0);
  return d;
}

/** 把 `HH:mm` 规范化（如 `9:5` → `09:05`）；非法返回 null */
export function normalizeTimeOfDay(t: string): TimeOfDay | null {
  const loose = /^(\d{1,2}):(\d{1,2})$/.exec(t.trim());
  if (loose) {
    const h = Number(loose[1]);
    const min = Number(loose[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${pad2(h)}:${pad2(min)}`;
  }
  const parsed = parseTimeOfDay(t);
  return parsed ? t : null;
}
