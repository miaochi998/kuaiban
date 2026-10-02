/**
 * 前后端契约测试（跨语言）
 *
 * 这些约定有一个共同点：**漏了不会有任何编译错误**，只会在运行时静默出错 ——
 * 而"用户以为记下了、其实没存进去"是本产品最不可接受的失败。
 * 所以必须用测试钉死。
 *
 * 三份契约：
 * 1. SQL 插件的 ACL 权限：少了 `allow-execute`，SELECT 能跑、INSERT 被拒。
 * 2. 数据库名：Rust 与 TS 不一致 → 加载到另一个库 → 表不存在。
 * 3. 迁移 SQL 的位置：全部走 `include_str!`，不能有遗留的内联 SQL
 *    （否则 Rust 建的表和 TS 测试验的表会悄悄分叉）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DB_URL } from "../src/data/todo-row";

const SRC_TAURI = new URL("../src-tauri/", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, SRC_TAURI), "utf8");
}

describe("SQL 插件权限（漏 allow-execute 不会有编译错误）", () => {
  const caps = JSON.parse(read("capabilities/default.json")) as { permissions: string[] };

  it("必须允许 execute —— 否则写库会被 ACL 静默拒绝", () => {
    expect(caps.permissions).toContain("sql:allow-execute");
  });

  it("必须允许 load（打开连接）", () => {
    expect(caps.permissions).toContain("sql:allow-load");
  });

  it("必须允许 select（读清单）", () => {
    expect(caps.permissions).toContain("sql:allow-select");
  });

  it("不要用 sql:default —— 它只含 allow-close/load/select，不含 allow-execute", () => {
    // 这条注释就是防回退：改了它，用户点保存就会静默失败。
    expect(caps.permissions).not.toContain("sql:default");
  });

  it("只申请用得到的权限（不顺手要 close）", () => {
    const sqlPerms = caps.permissions.filter((p) => p.startsWith("sql:"));
    expect(sqlPerms.sort()).toEqual([
      "sql:allow-execute",
      "sql:allow-load",
      "sql:allow-select",
    ]);
  });
});

describe("数据库名前后端一致", () => {
  const rust = read("src/lib.rs");

  it("Rust 里的 DB_URL 与 TS 侧逐字相同", () => {
    const m = /pub const DB_URL:\s*&str\s*=\s*"([^"]+)"/.exec(rust);
    expect(m, "在 src-tauri/src/lib.rs 里找不到 DB_URL").not.toBeNull();
    expect(m![1]).toBe(DB_URL);
  });

  it("迁移注册用的也是同一个常量（不是硬编码字符串）", () => {
    expect(rust).toContain("add_migrations(DB_URL, migrations())");
  });
});

describe("迁移 SQL 单一事实来源", () => {
  const rust = read("src/lib.rs");
  const migrationFiles = readdirSync(new URL("migrations/", SRC_TAURI)).filter((f) =>
    f.endsWith(".sql"),
  );

  it("migrations 目录里有 3 个迁移文件", () => {
    expect(migrationFiles).toHaveLength(3);
  });

  it("每个迁移文件都被 include_str! 引用", () => {
    for (const file of migrationFiles) {
      expect(rust, `${file} 没有被 include_str! 引用`).toContain(`include_str!("../migrations/${file}")`);
    }
  });

  it("lib.rs 里没有遗留的内联 CREATE TABLE（否则会和 .sql 文件分叉）", () => {
    expect(rust).not.toMatch(/CREATE\s+TABLE/i);
    expect(rust).not.toMatch(/CREATE\s+INDEX/i);
  });

  it("建表 SQL 里包含全部 15 个列", () => {
    const create = read("migrations/001_create_todos.sql");
    const cols = [
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
    ];
    for (const col of cols) {
      expect(create, `建表 SQL 缺少列 ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe("窗口与挂件的跨层契约", () => {
  const rust = read("src/lib.rs");
  const appVue = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");

  it("可见窄条高度：Rust 常量与 CSS 必须一致", () => {
    const m = /const STRIP_HEIGHT:\s*f64\s*=\s*([\d.]+)/.exec(rust);
    expect(m, "在 lib.rs 里找不到 STRIP_HEIGHT").not.toBeNull();
    const rustHeight = Number(m![1]);

    const css = /\.strip\s*\{[^}]*height:\s*([\d.]+)px/s.exec(appVue);
    expect(css, "在 App.vue 里找不到 .strip 的 height").not.toBeNull();
    expect(Number(css![1])).toBe(rustHeight);
  });
});
