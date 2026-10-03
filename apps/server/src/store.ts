/**
 * 服务端存储
 *
 * 用户、令牌、同步记录三件事都在这儿。**没有任何待办的业务规则** ——
 * 逾期、重复、提醒、冲突裁决全都在客户端的大脑里。
 * 服务端只做两件事：认人，和原样存取一坨它看不懂的内容。
 */

import type { DatabaseSync } from "node:sqlite";
import type { SyncPushItem, SyncRecord, SyncResponse } from "@kuaiban/core";
import { hashPassword, hashToken, newToken, verifyPassword } from "./auth.ts";
import { nowIso } from "./db.ts";

/** 单条载荷上限。待办内容很小，超过这个数一定是哪里出问题了 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** 单个用户的记录上限 —— 防滥用，也保证"全量拉一次"不会把客户端撑爆 */
const MAX_RECORDS_PER_USER = 20_000;

/** 一次拉取的上限，避免一个大请求把内存吃光 */
const MAX_PULL_LIMIT = 500;
const DEFAULT_PULL_LIMIT = 300;

/** 一个用户最多同时持有几个登录令牌（换设备用） */
const MAX_TOKENS_PER_USER = 20;

/**
 * ⚠️ 这里刻意写成"显式字段 + 构造函数里赋值"，而不是 TS 的参数属性
 * （`constructor(readonly code: string)`）。因为服务端是用 `node src/main.ts`
 * **直接跑 TypeScript** 的：Node 只做"类型擦除"，不做代码生成，
 * 而参数属性需要生成赋值语句 —— 用了它服务端起不来。
 */
export class StoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ServerUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
}

interface UserDbRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  must_change_password: number;
  disabled: number;
}

function toUser(row: UserDbRow): ServerUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled === 1,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ───────────────────────────────────────────────────────────
  // 用户
  // ───────────────────────────────────────────────────────────

  createUser(input: {
    username: string;
    displayName: string;
    password: string;
    isAdmin?: boolean;
  }): ServerUser {
    const username = input.username.trim();
    if (username.length < 2) throw new StoreError("bad_username", "登录名至少 2 个字符");

    const existing = this.db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(username);
    if (existing) throw new StoreError("username_taken", "这个登录名已经有人用了", 409);

    const row: UserDbRow = {
      id: crypto.randomUUID(),
      username,
      display_name: input.displayName.trim() || username,
      password_hash: hashPassword(input.password),
      is_admin: input.isAdmin ? 1 : 0,
      // 管理员发的初始密码只能用一次
      must_change_password: 1,
      disabled: 0,
    };

    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, is_admin,
                            must_change_password, disabled, next_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        row.id,
        row.username,
        row.display_name,
        row.password_hash,
        row.is_admin,
        row.must_change_password,
        row.disabled,
        nowIso(),
      );

    return toUser(row);
  }

  findById(id: string): ServerUser | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserDbRow
      | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): ServerUser[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at")
      .all() as unknown as UserDbRow[];
    return rows.map(toUser);
  }

  /** 校验口令；成功返回用户，失败返回 null（不区分"没这个人"和"密码错"，避免探测账号） */
  authenticate(username: string, password: string): ServerUser | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as UserDbRow | undefined;
    if (!row) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    if (row.disabled === 1) return null;
    return toUser(row);
  }

  /** 改口令。`mustChange` 决定下次登录是否还要再改 */
  setPassword(userId: string, password: string, mustChange: boolean): void {
    const result = this.db
      .prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?")
      .run(hashPassword(password), mustChange ? 1 : 0, userId);
    if (result.changes === 0) throw new StoreError("not_found", "用户不存在", 404);
    // 改密码之后把该用户所有登录令牌作废：旧密码泄露时这一步才是真的止血
    this.revokeAllForUser(userId);
  }

  setDisabled(userId: string, disabled: boolean): void {
    const result = this.db
      .prepare("UPDATE users SET disabled = ? WHERE id = ?")
      .run(disabled ? 1 : 0, userId);
    if (result.changes === 0) throw new StoreError("not_found", "用户不存在", 404);
    if (disabled) this.revokeAllForUser(userId);
  }

  countActiveAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0")
      .get() as { n: number };
    return Number(row.n);
  }

  // ───────────────────────────────────────────────────────────
  // 令牌
  // ───────────────────────────────────────────────────────────

  issueToken(userId: string, ttlMs: number): string {
    const { raw, hash } = newToken();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    this.db
      .prepare("INSERT INTO tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hash, userId, expiresAt, now);

    // 顺手清掉过期的，并限制每人的令牌数量
    this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(now);
    this.db
      .prepare(
        `DELETE FROM tokens WHERE token_hash IN (
           SELECT token_hash FROM tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(userId, MAX_TOKENS_PER_USER);

    return raw;
  }

  /** 用原始令牌换用户；过期或不存在返回 null */
  resolveToken(raw: string): ServerUser | null {
    const hash = hashToken(raw);
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM tokens WHERE token_hash = ?")
      .get(hash) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;

    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(hash);
      return null;
    }

    const user = this.findById(row.user_id);
    if (!user || user.disabled) return null;
    return user;
  }

  revokeToken(raw: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(hashToken(raw));
  }

  revokeAllForUser(userId: string): void {
    this.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
  }

  // ───────────────────────────────────────────────────────────
  // 同步
  //
  // 这一节里**没有任何业务判断**：不比较 updatedAt、不关心 deletedAt 的含义。
  // 冲突怎么裁决是客户端大脑的事（见 core/sync.ts）。服务端只是个仓库。
  // ───────────────────────────────────────────────────────────

  /**
   * 写入客户端推上来的记录。
   *
   * 每条记录都会拿到一个新的 `seq`。这是**必须的**：
   * 如果更新原地覆盖、seq 不变，另一台设备带着已经超过它的游标来拉，
   * 就会永远看不到这次修改 —— 一个非常隐蔽的"同步丢数据"。
   */
  push(userId: string, items: readonly SyncPushItem[]): {
    accepted: { id: string; seq: number }[];
    rejected: { id: string; reason: string }[];
  } {
    const accepted: { id: string; seq: number }[] = [];
    const rejected: { id: string; reason: string }[] = [];

    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM sync_records WHERE user_id = ?")
      .get(userId) as { n: number };
    let total = Number(countRow.n);

    const seqRow = this.db.prepare("SELECT next_seq FROM users WHERE id = ?").get(userId) as
      | { next_seq: number }
      | undefined;
    let seq = Number(seqRow?.next_seq ?? 0);

    const upsert = this.db.prepare(
      `INSERT INTO sync_records (user_id, id, payload, updated_at, deleted_at, seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         seq = excluded.seq`,
    );
    const exists = this.db.prepare(
      "SELECT 1 AS x FROM sync_records WHERE user_id = ? AND id = ?",
    );

    for (const item of items) {
      const isNew = exists.get(userId, item.id) === undefined;
      if (isNew && total + 1 > MAX_RECORDS_PER_USER) {
        rejected.push({ id: item.id, reason: "记录数已达上限" });
        continue;
      }
      if (Buffer.byteLength(item.payload, "utf8") > MAX_PAYLOAD_BYTES) {
        rejected.push({ id: item.id, reason: "单条内容过大" });
        continue;
      }
      if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128) {
        rejected.push({ id: String(item.id), reason: "id 非法" });
        continue;
      }

      seq += 1;
      upsert.run(userId, item.id, item.payload, item.updatedAt, item.deletedAt, seq);
      accepted.push({ id: item.id, seq });
      if (isNew) total += 1;
    }

    if (seq !== Number(seqRow?.next_seq ?? 0)) {
      this.db.prepare("UPDATE users SET next_seq = ? WHERE id = ?").run(seq, userId);
    }

    return { accepted, rejected };
  }

  /** 拉取 `cursor` 之后变化的记录。返回新游标与是否还有更多 */
  pull(userId: string, cursor: number, limit?: number): Omit<SyncResponse, "rejected"> {
    const take = Math.min(Math.max(1, limit ?? DEFAULT_PULL_LIMIT), MAX_PULL_LIMIT);

    const rows = this.db
      .prepare(
        `SELECT id, payload, updated_at, deleted_at, seq
           FROM sync_records
          WHERE user_id = ? AND seq > ?
          ORDER BY seq
          LIMIT ?`,
      )
      .all(userId, cursor, take + 1) as unknown as {
      id: string;
      payload: string;
      updated_at: string;
      deleted_at: string | null;
      seq: number;
    }[];

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    const records: SyncRecord[] = page.map((r) => ({
      id: r.id,
      payload: r.payload,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      seq: Number(r.seq),
    }));

    // 没有新记录时游标保持不动（不能退回去，否则会重复拉）
    const nextCursor = records.length > 0 ? records[records.length - 1]!.seq : cursor;

    // hasMore 时也算"还有更多"，让客户端立刻再拉一次
    return { pull: records, cursor: nextCursor, hasMore };
  }

  /** 已存记录条数。管理员界面只给这个数字 —— 不涉及任何内容 */
  countRecords(userId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sync_records WHERE user_id = ?")
      .get(userId) as { n: number };
    return Number(row.n);
  }

  /** 删掉一个用户及其全部数据（离职清理用） */
  deleteUser(userId: string): void {
    this.db.prepare("DELETE FROM sync_records WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }
}
