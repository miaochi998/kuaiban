/**
 * 待办实体操作（纯函数，全部返回新对象，不修改入参）
 *
 * 全部是 `(todo) => todo` 的纯变换。这样：
 * - 单元测试不需要任何 mock
 * - 撤销、同步、冲突合并将来都好做
 * - 大脑永远不碰"怎么存"这件事（那是存储适配器的职责）
 */

import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  NO_REPEAT,
  type DateKey,
  type NewTodoInput,
  type TimeOfDay,
  type Todo,
} from "@kuaiban/shared";
import { businessDateKey, diffDays, normalizeTimeOfDay } from "./date";
import { normalizeRepeatRule } from "./repeat";

export interface CreateTodoOptions {
  /** 当前时刻，默认 new Date() */
  now?: Date;
  /** 指定 id（测试用；生产默认走 crypto.randomUUID） */
  id?: string;
}

function newId(): string {
  // crypto.randomUUID 是 Web 标准，Node 19+ / 现代 WebView / 浏览器都有
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // 兜底：极端环境下也不用引依赖
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 新建待办。
 *
 * 默认值体现产品意图（业务逻辑文档 §5.1）：
 * - 有时间的，默认**开提醒**；没时间的（全天）默认**不开**，避免噪音
 * - 默认提前 0 分钟
 */
export function createTodo(input: NewTodoInput, opts: CreateTodoOptions = {}): Todo {
  const now = opts.now ?? new Date();
  const iso = now.toISOString();

  const title = input.title.trim();
  if (!title) throw new Error("待办内容不能为空");

  const time: TimeOfDay | null = input.time ? normalizeTimeOfDay(input.time) : null;

  return {
    id: opts.id ?? newId(),
    title,
    date: input.date ?? null,
    time,
    status: "pending",
    repeat: input.repeat ? normalizeRepeatRule(input.repeat) : NO_REPEAT,
    lastDoneDate: null,
    skippedDates: [],
    remind: input.remind ?? time !== null,
    remindBefore: input.remindBefore ?? 0,
    note: input.note ?? "",
    completedAt: null,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
  };
}

// ─────────────────────────────────────────────────────────────
// 完成 / 取消完成
// ─────────────────────────────────────────────────────────────

/**
 * 某个业务日这一次**是否已完成**。
 * - 一次性待办：看 status
 * - 重复待办：看 `lastDoneDate` 是否等于这一天（勾选只完成"本次"，系列继续）
 */
export function isOccurrenceDone(todo: Todo, dateKey: DateKey): boolean {
  if (todo.repeat.kind === "none") return todo.status === "done";
  return todo.lastDoneDate === dateKey;
}

/** 某个业务日这一次是否被显式跳过 */
export function isOccurrenceSkipped(todo: Todo, dateKey: DateKey): boolean {
  return todo.skippedDates.includes(dateKey);
}

/** 这一天是否还要做（未完成且未跳过） */
export function isOccurrencePending(todo: Todo, dateKey: DateKey): boolean {
  return !isOccurrenceDone(todo, dateKey) && !isOccurrenceSkipped(todo, dateKey);
}

/**
 * 完成某一天的这一次。
 * - 一次性：置 status = done，记 completedAt
 * - 重复：只把 `lastDoneDate` 推到这一天，**系列不受影响**
 */
export function completeOccurrence(todo: Todo, dateKey: DateKey, now: Date = new Date()): Todo {
  const iso = now.toISOString();
  if (todo.repeat.kind === "none") {
    return { ...todo, status: "done", completedAt: iso, updatedAt: iso };
  }
  return { ...todo, lastDoneDate: dateKey, updatedAt: iso };
}

/** 取消完成（勾错了） */
export function uncompleteOccurrence(todo: Todo, dateKey: DateKey, now: Date = new Date()): Todo {
  const iso = now.toISOString();
  if (todo.repeat.kind === "none") {
    return { ...todo, status: "pending", completedAt: null, updatedAt: iso };
  }
  // 只撤销"这一天"的完成；如果 lastDoneDate 是更早的日期，说明改的不是本次，保持原样
  if (todo.lastDoneDate !== dateKey) return todo;
  return { ...todo, lastDoneDate: null, updatedAt: iso };
}

/**
 * 跳过某一天的这一次（"今天不做了，但系列继续"）。
 * 它与"完成"的区别只体现在文案与统计上，对系列的影响一样：不影响。
 */
export function skipOccurrence(todo: Todo, dateKey: DateKey, now: Date = new Date()): Todo {
  const iso = now.toISOString();
  if (todo.repeat.kind === "none") {
    // 一次性待办没有"跳过本次"的概念，等价于取消
    return { ...todo, status: "cancelled", updatedAt: iso };
  }
  if (todo.skippedDates.includes(dateKey)) return todo;
  return {
    ...todo,
    skippedDates: [...todo.skippedDates, dateKey].sort(),
    updatedAt: iso,
  };
}

// ─────────────────────────────────────────────────────────────
// 排期 / 改期
// ─────────────────────────────────────────────────────────────

/**
 * 改到另一天。
 *
 * 对逾期顺延而言这是"搬到今天"：日期被改写，于是不再算逾期。
 * （不做顺延次数累加 —— 逾期天数由 `date` 与今天**派生**得出，
 *   天生不会和存储的计数不一致，见 core/view.ts 的 `overdueDays`。）
 */
export function moveToDate(todo: Todo, dateKey: DateKey | null, now: Date = new Date()): Todo {
  return { ...todo, date: dateKey, updatedAt: now.toISOString() };
}

/** 改动内容 / 时间 / 提醒（局部更新） */
export function updateTodo(
  todo: Todo,
  patch: Partial<
    Pick<Todo, "title" | "time" | "remind" | "remindBefore" | "note" | "repeat">
  >,
  now: Date = new Date(),
): Todo {
  const next: Todo = { ...todo, ...patch, updatedAt: now.toISOString() };
  if (patch.time !== undefined) {
    next.time = patch.time === null ? null : normalizeTimeOfDay(patch.time);
  }
  if (patch.repeat !== undefined) {
    next.repeat = normalizeRepeatRule(patch.repeat);
  }
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new Error("待办内容不能为空");
    next.title = t;
  }
  return next;
}

// ─────────────────────────────────────────────────────────────
// 删除
// ─────────────────────────────────────────────────────────────

/** 软删除。同步规则是"删除优先"，所以要留 deletedAt 给服务端看 */
export function softDelete(todo: Todo, now: Date = new Date()): Todo {
  return { ...todo, deletedAt: now.toISOString(), updatedAt: now.toISOString() };
}

/** 撤销删除 */
export function restore(todo: Todo, now: Date = new Date()): Todo {
  return { ...todo, deletedAt: null, updatedAt: now.toISOString() };
}

/** 是否是一条还活着的待办（没被删、没被取消） */
export function isAlive(todo: Todo): boolean {
  return todo.deletedAt === null && todo.status !== "cancelled";
}

// ─────────────────────────────────────────────────────────────
// 逾期
// ─────────────────────────────────────────────────────────────

/**
 * 一次性待办逾期天数（0 = 不逾期）。
 * **派生**而非存储：见 `completeOccurrence` 的注释。
 */
export function overdueDays(todo: Todo, now: Date = new Date()): number {
  if (todo.date === null) return 0;
  if (todo.repeat.kind !== "none") return 0; // 重复任务不产生"逾期"，避免天天报警
  if (todo.status !== "pending") return 0;
  const today = businessDateKey(now, DEFAULT_DAY_BOUNDARY_HOUR);
  if (todo.date >= today) return 0;
  return diffDays(todo.date, today);
}
