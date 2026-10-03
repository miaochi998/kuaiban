/**
 * 行 ↔ 实体 映射的契约测试
 *
 * 这是存储层最容易出错的地方：15 个列名、15 个参数，顺序错一个就会变成
 * "写进去了但读出来不对"——这种问题在界面上表现为"我明明记得打过卡，怎么没了"，
 * 极难排查。所以这里用**往返一致性**把它钉死。
 *
 * 另一条被钉死的约定：`TODO_COLUMNS` 必须与 Rust 迁移里的表结构一一对应。
 * Rust 侧的列名如果改了而这里没改，测试不会失败（跨语言），
 * 但至少 SQL 与参数顺序在 TS 侧是自洽的，不会出现静默错位。
 */

import { describe, expect, it, vi } from "vitest";
import { buildDailyView, createTodo, type Todo } from "@kuaiban/core";
import {
  TODO_COLUMNS,
  UPSERT_SQL,
  parseRepeat,
  parseSkippedDates,
  parseStatus,
  rowToTodo,
  sanitizeDateKey,
  sanitizeTime,
  todoToParams,
  type TodoRow,
} from "../src/data/todo-row";

const NOW = new Date("2026-06-15T09:00:00");

/** 模拟数据库：把参数按列顺序塞回一行 */
function toRow(todo: Todo): TodoRow {
  const params = todoToParams(todo);
  const row: Record<string, unknown> = {};
  TODO_COLUMNS.forEach((col, i) => {
    row[col] = params[i];
  });
  return row as unknown as TodoRow;
}

function sample(overrides: Partial<Parameters<typeof createTodo>[0]> = {}): Todo {
  return createTodo(
    { title: "交周报", date: "2026-06-15", time: "17:00", ...overrides },
    { now: NOW, id: "t1" },
  );
}

describe("SQL 与列定义自洽", () => {
  it("列数 == 参数个数", () => {
    expect(todoToParams(sample())).toHaveLength(TODO_COLUMNS.length);
  });

  it("UPSERT_SQL 里的占位符个数 == 列数", () => {
    const placeholders = UPSERT_SQL.match(/\?/g) ?? [];
    expect(placeholders).toHaveLength(TODO_COLUMNS.length);
  });

  it("UPSERT_SQL 覆盖了每一列", () => {
    for (const col of TODO_COLUMNS) {
      expect(UPSERT_SQL).toContain(col);
    }
  });

  it("冲突时更新除主键外的所有列", () => {
    for (const col of TODO_COLUMNS) {
      if (col === "id") {
        expect(UPSERT_SQL).not.toContain(`id = excluded.id`);
      } else {
        expect(UPSERT_SQL).toContain(`${col} = excluded.${col}`);
      }
    }
  });

  it("列名与 Rust 迁移保持一致（防手滑改名）", () => {
    expect([...TODO_COLUMNS]).toEqual([
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
    ]);
  });
});

describe("往返一致性：Todo → 行 → Todo 完全相等", () => {
  it("普通待办", () => {
    const todo = sample();
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("随笔（日期为空、时间为空、不提醒）", () => {
    const todo = createTodo({ title: "一个灵感" }, { now: NOW, id: "t2" });
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("每周重复", () => {
    const todo = sample({ title: "周会", repeat: { kind: "weekly", weekdays: [1, 3, 5] } });
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("每月重复", () => {
    const todo = sample({ repeat: { kind: "monthly", days: [1, 15, 31] } });
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("已完成", () => {
    const todo: Todo = {
      ...sample(),
      status: "done",
      completedAt: "2026-06-15T10:00:00.000Z",
    };
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("重复待办的完成与跳过记录", () => {
    const todo: Todo = {
      ...sample({ repeat: { kind: "daily" } }),
      lastDoneDate: "2026-06-15",
      skippedDates: ["2026-06-10", "2026-06-12"],
    };
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("已软删除（同步需要看到这个事实）", () => {
    const todo: Todo = { ...sample(), deletedAt: "2026-06-15T11:00:00.000Z" };
    const row = toRow(todo);
    expect(row.deleted_at).toBe("2026-06-15T11:00:00.000Z");
    expect(rowToTodo(row)).toEqual(todo);
  });

  it("备注、提前提醒、关闭提醒", () => {
    const todo: Todo = {
      ...sample(),
      note: "记得带上合同原件\n以及复印件",
      remind: true,
      remindBefore: 30,
    };
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });

  it("内容里有单引号和换行也不会被破坏（参数化查询的意义）", () => {
    const todo = sample({ title: "他说：'周五之前' 交\n别忘了" });
    expect(rowToTodo(toRow(todo))).toEqual(todo);
  });
});

describe("boolean 与 0/1 的转换", () => {
  it("remind=true 存 1", () => {
    expect(todoToParams({ ...sample(), remind: true })[8]).toBe(1);
  });

  it("remind=false 存 0", () => {
    expect(todoToParams({ ...sample(), remind: false })[8]).toBe(0);
  });

  it("读回 0/1 都还原成 boolean", () => {
    expect(rowToTodo({ ...toRow(sample()), remind: 0 }).remind).toBe(false);
    expect(rowToTodo({ ...toRow(sample()), remind: 1 }).remind).toBe(true);
  });
});

describe("坏数据退化（一条坏记录不该让整个清单打不开）", () => {
  it("repeat 不是合法 JSON → 退化为不重复", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRepeat("{坏掉的", "t1")).toEqual({ kind: "none" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("repeat 是合法 JSON 但不是规则对象 → 退化为不重复", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRepeat("123", "t1")).toEqual({ kind: "none" });
    expect(parseRepeat("null", "t1")).toEqual({ kind: "none" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skipped_dates 不是数组 → 退化为空数组", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSkippedDates('{"a":1}', "t1")).toEqual([]);
    expect(parseSkippedDates("坏掉的", "t1")).toEqual([]);
    warn.mockRestore();
  });

  it("skipped_dates 里混了非字符串 → 退化为空数组", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseSkippedDates('["2026-06-15", 123]', "t1")).toEqual([]);
    warn.mockRestore();
  });

  it("status 非法 → 退化为 pending", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStatus("什么鬼", "t1")).toBe("pending");
    expect(parseStatus("done", "t1")).toBe("done");
    expect(parseStatus("cancelled", "t1")).toBe("cancelled");
    warn.mockRestore();
  });

  it("整行里只有 repeat 坏掉时，其它字段照常读出来", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row: TodoRow = { ...toRow(sample()), repeat: "{坏掉的" };
    const todo = rowToTodo(row);
    expect(todo.repeat).toEqual({ kind: "none" });
    expect(todo.title).toBe("交周报");
    expect(todo.time).toBe("17:00");
    warn.mockRestore();
  });
});

describe("空值与默认值", () => {
  it("随笔的 date/time 存 null 并读回 null", () => {
    const row = toRow(createTodo({ title: "灵感" }, { now: NOW, id: "t9" }));
    expect(row.date).toBeNull();
    expect(row.time).toBeNull();
    expect(row.last_done_date).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("repeat 与 skipped_dates 以 JSON 文本存储", () => {
    const row = toRow(sample({ repeat: { kind: "weekly", weekdays: [1] } }));
    expect(JSON.parse(row.repeat)).toEqual({ kind: "weekly", weekdays: [1] });
    expect(JSON.parse(row.skipped_dates)).toEqual([]);
  });
});

describe("坏数据的最后一道防线：date / time 清洗", () => {
  it("合法的日期与时间原样保留", () => {
    expect(sanitizeDateKey("2026-10-03")).toBe("2026-10-03");
    expect(sanitizeTime("09:30")).toBe("09:30");
    expect(sanitizeTime("00:00")).toBe("00:00");
    expect(sanitizeTime("23:59")).toBe("23:59");
  });

  it("空字符串当 null —— 真实踩过的坑：一条 date='' 会让整个界面渲染崩掉", () => {
    expect(sanitizeDateKey("")).toBeNull();
    expect(sanitizeTime("")).toBeNull();
  });

  it("格式不对的一律当 null，不抛异常", () => {
    for (const bad of ["2026/10/03", "26-10-03", "2026-1-3", "今天", "  ", "null"]) {
      expect(sanitizeDateKey(bad)).toBeNull();
    }
    for (const bad of ["9:30", "25:00", "09:60", "9点半", "abc"]) {
      expect(sanitizeTime(bad)).toBeNull();
    }
  });

  it("非字符串也当 null（数据库里可能是数字）", () => {
    expect(sanitizeDateKey(null)).toBeNull();
    expect(sanitizeDateKey(20261003)).toBeNull();
    expect(sanitizeTime(null)).toBeNull();
    expect(sanitizeTime(930)).toBeNull();
  });

  it("整行 date='' 时退化成『未排期』，其余字段照常读出来", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row: TodoRow = { ...toRow(sample()), date: "", time: "" };
    const todo = rowToTodo(row);
    expect(todo.date).toBeNull();
    expect(todo.time).toBeNull();
    expect(todo.title).toBe("交周报");
    warn.mockRestore();
  });

  it("清洗后的对象能安全喂给大脑的视图函数（不会抛「非法的日期 key」）", () => {
    const row: TodoRow = { ...toRow(sample()), date: "", time: "" };
    const todo = rowToTodo(row);
    // 这一步以前会抛 "非法的日期 key: """，导致整个界面渲染失败
    expect(() => buildDailyView([todo], { now: NOW })).not.toThrow();
    expect(buildDailyView([todo], { now: NOW }).inbox.map((t) => t.id)).toEqual([todo.id]);
  });
});
