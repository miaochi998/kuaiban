/**
 * 行 ↔ 领域对象 的映射（**纯函数，零平台依赖**）
 *
 * 为什么单独放一个文件：这是整个存储层最容易出错、也最值得测的地方 ——
 * 15 个列的名字和参数顺序必须与 SQL 严格对齐，错一个就是"数据写进去但读出来不对"
 * 这种极难排查的问题。
 *
 * 拆出来之后它不依赖 `@tauri-apps/plugin-sql`，可以在纯 Node 环境下跑单元测试，
 * 用"数据库行 → Todo → 参数 → 数据库行"的往返一致性来守住这条契约。
 *
 * ⚠️ 本文件**一行业务规则都不许有**。任何"逾期怎么算""重复怎么展开"都属于大脑。
 */

import { NO_REPEAT, type RepeatRule, type Todo, type TodoStatus } from "@kuaiban/core";

/**
 * 数据库逻辑名。
 *
 * ⚠️ **必须与 Rust 侧 `lib.rs` 里的 `DB_URL` 完全一致**，否则插件会去加载另一个
 * （不存在的）库，迁移也不会跑 —— 表现为"表不存在"，数据一条都存不进去。
 * 这条跨语言契约由 `test/backend-contract.test.ts` 自动核对。
 */
export const DB_URL = "sqlite:kuaiban.db";

/** 数据库里的一行（与 Rust 迁移里的表结构一一对应，snake_case） */
export interface TodoRow {
  id: string;
  title: string;
  date: string | null;
  time: string | null;
  status: string;
  repeat: string;
  last_done_date: string | null;
  skipped_dates: string;
  remind: number;
  remind_before: number;
  note: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const TODO_STATUSES: readonly string[] = ["pending", "done", "cancelled"];

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 清洗日期列：只有合法的 `YYYY-MM-DD` 才保留，其余（空串、垃圾、格式不对）一律当"未排期"。
 *
 * 为什么必须做 —— 真实踩过的坑：
 * 库里有一条 `date = ''` 的坏记录，`fromDateKey('')` 在渲染期间抛错，
 * **整个界面渲染失败**，用户看到的是"永远停在正在读取…"，
 * 既看不到别的待办，也完全不知道发生了什么。
 * 一条坏数据绝不该让整个清单打不开 —— 这和 `parseRepeat` 的降级是同一个道理。
 */
export function sanitizeDateKey(raw: unknown): string | null {
  return typeof raw === "string" && DATE_KEY_RE.test(raw) ? raw : null;
}

/** 清洗时间列：只有合法的 `HH:mm` 才保留，其余当"全天事项" */
export function sanitizeTime(raw: unknown): string | null {
  return typeof raw === "string" && TIME_RE.test(raw) ? raw : null;
}

/** 把任意抛出物转成能读的消息（Tauri 抛的不一定是 Error） */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 解析 `repeat` 字段。
 *
 * 解析失败**不抛异常**：一条坏数据不该让整个清单打不开。
 * 退化成"不重复"并留下警告 —— 用户至少还能看到别的待办、还能去修它。
 */
export function parseRepeat(raw: string, id: string): RepeatRule {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as RepeatRule;
    }
    throw new Error("不是合法的重复规则对象");
  } catch (err) {
    console.warn(
      `[快办] 待办 ${id} 的 repeat 字段无法解析，已退化为「不重复」。原始值：${raw}`,
      describeError(err),
    );
    return NO_REPEAT;
  }
}

/** 解析 `skipped_dates`，失败同样退化成安全默认值 */
export function parseSkippedDates(raw: string, id: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((d) => typeof d === "string")) {
      return parsed;
    }
    throw new Error("不是字符串数组");
  } catch (err) {
    console.warn(
      `[快办] 待办 ${id} 的 skipped_dates 字段无法解析，已退化为空数组。原始值：${raw}`,
      describeError(err),
    );
    return [];
  }
}

export function parseStatus(raw: string, id: string): TodoStatus {
  if (typeof raw === "string" && TODO_STATUSES.includes(raw)) {
    return raw as TodoStatus;
  }
  console.warn(`[快办] 待办 ${id} 的 status 非法（${String(raw)}），已退化为 pending`);
  return "pending";
}

/** 数据库行 → 领域对象 */
export function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    date: sanitizeDateKey(row.date),
    time: sanitizeTime(row.time),
    status: parseStatus(row.status, row.id),
    repeat: parseRepeat(row.repeat, row.id),
    lastDoneDate: row.last_done_date,
    skippedDates: parseSkippedDates(row.skipped_dates, row.id),
    // SQLite 没有原生 boolean，用 0/1
    remind: row.remind !== 0,
    remindBefore: row.remind_before,
    note: row.note,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * 领域对象 → SQL 参数数组。
 *
 * 顺序必须与 `UPSERT_SQL` 里 `?` 的出现顺序**严格一致**。
 * 两边都写成同一种排版，方便肉眼对齐；`test/todo-row.test.ts` 里另有往返测试兜底。
 */
export function todoToParams(todo: Todo): unknown[] {
  return [
    todo.id,
    todo.title,
    todo.date,
    todo.time,
    todo.status,
    JSON.stringify(todo.repeat),
    todo.lastDoneDate,
    JSON.stringify(todo.skippedDates),
    todo.remind ? 1 : 0,
    todo.remindBefore,
    todo.note,
    todo.completedAt,
    todo.createdAt,
    todo.updatedAt,
    todo.deletedAt,
  ];
}

/**
 * 插入 / 覆盖的列顺序。
 *
 * 参数顺序以它为准 —— 单测会核对"列数 == 参数个数 == UPSERT_SQL 里的 ? 个数"。
 */
export const TODO_COLUMNS = [
  "id",
  "title",
  "date",
  "time",
  "status",
  "repeat",
  "last_done_date",
  "skipped_dates",
  "remind",
  "remind_before",
  "note",
  "completed_at",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

/**
 * 按 id 覆盖写入。
 *
 * 用 `ON CONFLICT(id) DO UPDATE`（SQLite 的 upsert 语法）而不是"先查再决定
 * INSERT 还是 UPDATE"：后者有竞态，而且要多一次往返。
 *
 * 值一律走 `?` 占位符参数化传入 —— 待办内容是用户随手打的，
 * 拼字符串既可能因为引号出错，也是注入风险的来源。
 *
 * 刻意**不更新** `id`：主键不该被改写。
 */
export const UPSERT_SQL = `
INSERT INTO todos (
  ${TODO_COLUMNS.join(", ")}
) VALUES (${TODO_COLUMNS.map(() => "?").join(", ")})
ON CONFLICT(id) DO UPDATE SET
${TODO_COLUMNS.filter((c) => c !== "id")
  .map((c) => `  ${c} = excluded.${c}`)
  .join(",\n")}
`;
