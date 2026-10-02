-- 快办 —— todos 表
--
-- ⚠️ 这是**单一事实来源**：Rust 侧用 include_str! 加载它做迁移，
-- 测试用它建真库跑往返验证。两边不可能再对不上。
--
-- 约定：
-- - 列名 snake_case，领域对象字段 camelCase，映射在 apps/desktop/src/data/todo-row.ts
-- - repeat / skipped_dates 存 JSON 文本（重复规则是封闭的小联合类型，从不参与查询条件，
--   拆关联表只会让读写变成多次往返）
-- - remind 用 0/1（SQLite 没有原生 boolean）
-- - 软删除靠 deleted_at，不做物理删除：同步规则是"删除优先"

CREATE TABLE IF NOT EXISTS todos (
  id             TEXT PRIMARY KEY NOT NULL,
  title          TEXT NOT NULL,
  date           TEXT,
  time           TEXT,
  status         TEXT NOT NULL,
  repeat         TEXT NOT NULL,
  last_done_date TEXT,
  skipped_dates  TEXT NOT NULL DEFAULT '[]',
  remind         INTEGER NOT NULL DEFAULT 0,
  remind_before  INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  completed_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
