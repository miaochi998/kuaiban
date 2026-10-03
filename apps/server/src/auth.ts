/**
 * 口令与令牌的密码学部分
 *
 * 两条原则：
 * 1. **口令用慢哈希**（scrypt）：口令熵低，快哈希等于给暴力破解提速
 * 2. **令牌用快哈希**（SHA-256）：令牌是 32 字节随机串，熵足够高，
 *    不需要慢哈希；而且每次请求都要校验，慢哈希会把服务器拖死
 *
 * 令牌**只存哈希**：数据库被人看到，也不能直接拿去冒充别人。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt 参数。N 越大越慢越安全；16384 在服务器上约 50–100ms，够用且不拖垮登录。
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** 生成口令哈希，格式 `scrypt$N$r$p$salt$key`（自带参数，将来调参不影响老数据） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** 校验口令。任何异常一律返回 false（不能因为格式怪就放行） */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (expected.length === 0) return false;

    const actual = scryptSync(password, salt, expected.length, {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
    });

    // 定长比较，避免通过耗时差异逐字节猜出哈希
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 口令强度检查。
 *
 * 刻意只要求 8 位 —— 这是个公司内部工具，规则太严会逼用户写便利贴。
 * 真正防住的是"管理员发的初始密码必须改"和登录频率限制。
 */
export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < 8) return "密码至少 8 位";
  if (password.length > 200) return "密码太长了";
  return null;
}
