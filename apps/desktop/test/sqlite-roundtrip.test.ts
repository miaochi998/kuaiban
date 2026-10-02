/**
 * 真库往返测试 —— 用真正的 SQLite 引擎执行真正的 SQL
 *
 * 为什么必须有这个测试：
 * `todo-row.test.ts` 只验证了映射的**形状**，但 `UPSERT_SQL` 那段 SQL
 * 从来没有被任何引擎执行过。语法写错、列名写错、占位符个数不对，
 * 都要等用户在界面上点一下"保存"才会炸 —— 而那时候用户已经以为东西记下了。
 *
 * 这里用 Node 内置的 `node:sqlite` 建一个真库，**读 Rust 侧同一份 .sql 迁移文件**
 * 建表（不是抄一遍），然后用真实的 `UPSERT_SQL` 读写。
 * 于是"Rust 建的表"和"TS 读写的表"之间不存在重复定义，也不可能对不上。
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createTodo, type Todo } from "@kuaiban/core";
import { UPSERT_SQL, rowToTodo, todoToParams, type TodoRow } from "../src/data/todo-row";

/** Rust 侧的迁移目录（单一事实来源） */
const MIGRATIONS_DIR = new URL("../src-tauri/migrations/", import.meta.url);

function readMigration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
}

/** 用与 Rust 完全相同的迁移 SQL 建一个空库 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readMigration("001_create_todos.sql"));
  db.exec(readMigration("002_index_todos_date.sql"));
  db.exec(readMigration("003_index_todos_updated_at.sql"));
  return db;
}

type Param = string | number | null;

function save(db: DatabaseSync, todo: Todo): void {
  db.prepare(UPSERT_SQL).run(...(todoToParams(todo) as Param[]));
}

function loadAll(db: DatabaseSync): Todo[] {
  const rows = db.prepare("SELECT * FROM todos").all() as unknown as TodoRow[];
  return rows.map(rowToTodo);
}

const NOW = new Date("2026-06-15T09:00:00");

function sample(overrides: Partial<Parameters<typeof createTodo>[0]> = {}, id = "t1"): Todo {
  return createTodo(
    { title: "交周报", date: "2026-06-15", time: "17:00", ...overrides },
    { now: NOW, id },
  );
}

describe("迁移 SQL 本身可用", () => {
  it("建表语句能被真 SQLite 执行", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("列名与 TS 侧约定一致", () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info(todos)").all() as unknown as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual([
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

  it("索引建出来了", () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos'")
      .all() as unknown as { name: string }[];
    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_todos_date");
    expect(names).toContain("idx_todos_updated_at");
  });

  it("重复执行迁移是幂等的（IF NOT EXISTS）", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("001_create_todos.sql"))).not.toThrow();
  });
});

describe("UPSERT_SQL 真的能跑", () => {
  it("插入后能原样读回", () => {
    const db = freshDb();
    const todo = sample();
    save(db, todo);

    const loaded = loadAll(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(todo);
  });

  it("同 id 再写一次是更新，不会变成两条", () => {
    const db = freshDb();
    const todo = sample();
    save(db, todo);

    save(db, { ...todo, title: "交周报（改过）", status: "done" });

    const loaded = loadAll(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.title).toBe("交周报（改过）");
    expect(loaded[0]!.status).toBe("done");
  });

  it("所有字段都能正确往返（含 JSON、null、中文、单引号）", () => {
    const db = freshDb();
    const todo: Todo = {
      ...sample({
        title: "他说：'周五之前' 给我\n别忘了带合同",
        repeat: { kind: "weekly", weekdays: [1, 3, 5] },
        note: "备注里也有 ' 单引号",
      }),
      lastDoneDate: "2026-06-08",
      skippedDates: ["2026-06-01", "2026-06-03"],
      remindBefore: 30,
      completedAt: "2026-06-15T10:00:00.000Z",
      deletedAt: null,
    };
    save(db, todo);
    expect(loadAll(db)[0]).toEqual(todo);
  });

  it("随笔（date/time 为 null）也能往返", () => {
    const db = freshDb();
    const todo = createTodo({ title: "一个灵感" }, { now: NOW, id: "t2" });
    save(db, todo);
    const loaded = loadAll(db)[0]!;
    expect(loaded.date).toBeNull();
    expect(loaded.time).toBeNull();
    expect(loaded).toEqual(todo);
  });

  it("多写几条都能读出来，且顺序不丢数据", () => {
    const db = freshDb();
    const todos = ["a", "b", "c"].map((t, i) =>
      createTodo({ title: t, date: "2026-06-15" }, { now: NOW, id: `t${i}` }),
    );
    for (const t of todos) save(db, t);
    expect(loadAll(db).map((t) => t.title).sort()).toEqual(["a", "b", "c"]);
  });

  it("list 读出软删除的记录（同步需要看到「这条被删了」）", () => {
    const db = freshDb();
    const todo = { ...sample(), deletedAt: "2026-06-15T11:00:00.000Z" };
    save(db, todo);
    expect(loadAll(db)).toHaveLength(1);
    expect(loadAll(db)[0]!.deletedAt).toBe("2026-06-15T11:00:00.000Z");
  });

  it("主键约束在位：id 不会被 upsert 改写", () => {
    const db = freshDb();
    const todo = sample({}, "fixed-id");
    save(db, todo);
    save(db, { ...todo, title: "改过" });
    const rows = db.prepare("SELECT id FROM todos").all() as unknown as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["fixed-id"]);
  });

  it("remind 真的存成 0/1 而不是 true/false", () => {
    const db = freshDb();
    save(db, { ...sample(), remind: true });
    save(db, { ...sample(), id: "t2", remind: false });
    const rows = db.prepare("SELECT id, remind FROM todos ORDER BY id").all() as unknown as {
      id: string;
      remind: number;
    }[];
    expect(rows).toEqual([
      { id: "t1", remind: 1 },
      { id: "t2", remind: 0 },
    ]);
  });

  it("NOT NULL 约束真的在拦（防止静默写入坏数据）", () => {
    const db = freshDb();
    const bad = { ...todoToParams(sample()) };
    bad[1] = null; // title 不能为空
    expect(() => db.prepare(UPSERT_SQL).run(...(bad as Param[]))).toThrow();
  });
});

describe("与大脑的完整闭环（真库）", () => {
  it("新建 → 重启后还在", () => {
    const db = freshDb();
    save(db, sample({ title: "给客户回电话", date: "2026-06-10" }));

    // 模拟"关掉软件再打开"：重新读库
    const reloaded = loadAll(db);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.title).toBe("给客户回电话");
    expect(reloaded[0]!.date).toBe("2026-06-10");
  });

  it("改期后再读，日期确实变了", () => {
    const db = freshDb();
    const todo = sample({ title: "报销单", date: "2026-06-10" });
    save(db, todo);
    save(db, { ...todo, date: "2026-06-15" });

    expect(loadAll(db)[0]!.date).toBe("2026-06-15");
  });
});
