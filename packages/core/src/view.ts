/**
 * 视图切分 —— 「今天 / 明天 / 日历 / 随笔」是同一份数据的四种看法
 *
 * 这是本软件的灵魂所在（业务逻辑文档 §4.2、§6.1）：
 *
 *   今天清单 = 业务日 == 今天的
 *   明天清单 = 业务日 == 明天的
 *   日历     = 按天摊开
 *   随笔     = 日期为空的
 *
 * **逾期顺延不需要任何定时任务**：它只是"业务日变了"。昨天没做完的事，
 * `date < 今天` 这个条件今天自动成立，于是自动出现在「昨日未完成」区。
 * 没有"翻天作业"，也就没有"作业没跑所以数据错了"这种故障模式。
 */

import { DEFAULT_DAY_BOUNDARY_HOUR, type DateKey, type Todo } from "@kuaiban/shared";
import { addDays, businessDateKey, diffDays } from "./date";
import { occursOn } from "./repeat";
import {
  isAlive,
  isOccurrenceDone,
  isOccurrenceSkipped,
  isOccurrencePending,
} from "./todo";

/** 逾期 ≥ 这个天数，就该温和提醒用户"要不要改期 / 拆小 / 放弃" */
export const OVERDUE_ATTENTION_DAYS = 3;

export interface OverdueTodo {
  todo: Todo;
  /** 拖了几天（派生，见 core/todo.ts 的 overdueDays 注释） */
  overdueDays: number;
  /** 是否已经拖到需要提醒的程度 */
  needsAttention: boolean;
}

export interface DailyView {
  /** 当前的业务日（凌晨 4 点前算前一天） */
  businessDate: DateKey;
  /** 明天 */
  tomorrowDate: DateKey;

  /** 昨天及更早、还没做完的（清单顶部单独一区） */
  overdue: OverdueTodo[];
  /** 今天要做的 */
  today: Todo[];
  /** 明天要做的 */
  tomorrow: Todo[];
  /** 随笔：未排期的（待办暂存区） */
  inbox: Todo[];
  /** 今天已完成的（折叠区） */
  doneToday: Todo[];

  /** 今日未完成总数（含逾期）—— 挂件角标用 */
  remainingCount: number;
  /** 拖太久、需要温和提醒的条目 */
  needsAttention: OverdueTodo[];
}

/**
 * 列表排序：按时间升序，**没时间的排最后**；同一时间的按创建时间。
 * 为什么这样排：用户一天的时间感是由"几点做什么"驱动的，
 * 顺手就能做的小事（没设时间）不该插在 09:30 的会前面。
 */
export function sortForList(a: Todo, b: Todo): number {
  if (a.time && b.time) {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  } else if (a.time) {
    return -1;
  } else if (b.time) {
    return 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildViewOptions {
  now?: Date;
  /** 业务日分界小时，默认 04:00 */
  boundaryHour?: number;
}

export function buildDailyView(todos: Todo[], opts: BuildViewOptions = {}): DailyView {
  const now = opts.now ?? new Date();
  const boundaryHour = opts.boundaryHour ?? DEFAULT_DAY_BOUNDARY_HOUR;

  const businessDate = businessDateKey(now, boundaryHour);
  const tomorrowDate = addDays(businessDate, 1);

  const overdue: OverdueTodo[] = [];
  const today: Todo[] = [];
  const tomorrow: Todo[] = [];
  const inbox: Todo[] = [];
  const doneToday: Todo[] = [];

  for (const todo of todos) {
    if (!isAlive(todo)) continue;

    // ── 随笔：未排期 ──
    if (todo.date === null) {
      inbox.push(todo);
      continue;
    }

    // ── 重复任务：看规则在这一天有没有发生 ──
    if (todo.repeat.kind !== "none") {
      if (occursOn(todo, businessDate)) {
        if (isOccurrencePending(todo, businessDate)) today.push(todo);
        else doneToday.push(todo);
      } else if (occursOn(todo, tomorrowDate)) {
        tomorrow.push(todo);
      }
      // 重复任务**不会**进"昨日未完成"：昨天的没做就是没做，
      // 天天把"每天喝水"挂在逾期区只会让人麻木（业务逻辑文档 §6.3）
      continue;
    }

    // ── 一次性任务：已完成 ──
    if (todo.status === "done") {
      if (todo.completedAt) {
        const doneKey = businessDateKey(new Date(todo.completedAt), boundaryHour);
        if (doneKey === businessDate) doneToday.push(todo);
      }
      continue;
    }

    // ── 一次性任务：未完成，按日期分桶 ──
    if (todo.date < businessDate) {
      const days = diffDays(todo.date, businessDate);
      overdue.push({ todo, overdueDays: days, needsAttention: days >= OVERDUE_ATTENTION_DAYS });
    } else if (todo.date === businessDate) {
      today.push(todo);
    } else if (todo.date === tomorrowDate) {
      tomorrow.push(todo);
    }
    // 更远的未来不进日视图，由日历负责
  }

  overdue.sort((a, b) => sortForList(a.todo, b.todo));
  today.sort(sortForList);
  tomorrow.sort(sortForList);
  // 随笔区：最新的在最上面（像收件箱）
  inbox.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  // 已完成：最近完成的在上面
  doneToday.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return {
    businessDate,
    tomorrowDate,
    overdue,
    today,
    tomorrow,
    inbox,
    doneToday,
    remainingCount: overdue.length + today.length,
    needsAttention: overdue.filter((o) => o.needsAttention),
  };
}

/**
 * 某一天该做哪些事（日历视图用）。
 * 一次性看 date 是否命中，重复看规则是否发生。
 */
export function todosOnDate(todos: Todo[], dateKey: DateKey): Todo[] {
  return todos.filter((t) => isAlive(t) && occursOn(t, dateKey)).sort(sortForList);
}

/** 某一天是否还有未完成的事（日历上打点用） */
export function hasPendingOn(todos: Todo[], dateKey: DateKey): boolean {
  return todosOnDate(todos, dateKey).some((t) => isOccurrencePending(t, dateKey));
}

/**
 * 一个月的日历网格数据（含前后补齐的整周，从周一开始）。
 * 返回 42 个格子（6 周），月视图排版稳定不跳动。
 */
export function monthGrid(year: number, month1: number): DateKey[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = new Date(year, month1 - 1, 1);
  const weekday = first.getDay() === 0 ? 7 : first.getDay(); // 1..7
  const start = new Date(year, month1 - 1, 1 - (weekday - 1));

  const cells: DateKey[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return cells;
}
