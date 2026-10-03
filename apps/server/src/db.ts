/**
 * 服务端数据库
 *
 * 只用 `node:sqlite`（Node 自带），**不引任何第三方运行时依赖**。
 * 理由：这是个给几十个人用的小工具，服务器越简单越好部署、越少东西要审计。
 *
 * ## 最重要的一条：这张表里没有"内容"
 *
 * `sync_records.payload` 对服务端是**一坨看不懂的字符串**。
 * 服务端不解析、不索引、不搜索、不统计，只负责原样存取。
 * 这是"管理员看不到用户待办内容"这条要求在服务端侧的兑现方式 ——
 * 不是"我们不看"，而是**看不到**。
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  is_admin             INTEGER NOT NULL DEFAULT 0,
  -- 管理员发的初始密码只能用一次，首次登录必须改
  must_change_password INTEGER NOT NULL DEFAULT 1,
  disabled             INTEGER NOT NULL DEFAULT 0,
  -- 每个用户独立的单调递增序号，增量同步的游标就用它。
  -- 不用时间做游标：客户端时钟不可信，会漏记录。
  next_seq             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  -- 只存 token 的哈希：库被看到也不能直接拿来冒充别人
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS sync_records (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  -- 服务端看不懂的一坨（将来是密文）。见文件顶部说明。
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_pull ON sync_records(user_id, seq);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
