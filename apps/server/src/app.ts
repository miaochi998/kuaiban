/**
 * HTTP 接口
 *
 * 用 `node:http` 手写一个极小的路由，不引框架。
 * 一共不到十个接口，为此装一个框架（以及它的依赖树）不划算。
 *
 * ## 隐私边界（这个文件最重要的约束）
 *
 * 管理员的接口**只能**看到账号信息和"存了多少条记录"这种计数，
 * **绝不能**出现任何待办内容的读取路径 —— 连"为了调试"的都不留。
 * 服务端本来就只有密文/不透明载荷，这里再守住一次，两道门。
 */

import { readFileSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncRequest } from "@kuaiban/core";
import { passwordProblem } from "./auth.ts";
import type { ReleaseStore } from "./releases.ts";
import {
  applyUpgrade,
  checkServerUpdate,
  loadUpgradeConfig,
  publicUpgradeConfig,
  saveUpgradeConfig,
  type UpgradeConfig,
} from "./upgrade.ts";
import { Store, StoreError, type ServerUser } from "./store.ts";

/** 登录令牌有效期：30 天。桌面挂件不该天天让用户重新登录 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 请求体上限：待办内容很小，1MB 足够，防止有人拿它当网盘 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 登录失败限流：同一登录名 15 分钟内最多 10 次失败 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

/**
 * 管理后台页面。
 *
 * 刻意做成**一个静态 HTML 文件**：零构建步骤、零前端依赖，
 * 服务端启动时读进内存直接发。管理员在浏览器里打开就能用，不用装任何东西。
 * 这和整个服务端"不要第三方运行时依赖"的思路是一致的。
 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function readPage(name: string): string {
  return readFileSync(join(PUBLIC_DIR, name), "utf8");
}

/** 发布下载页（公开，任何人都能看）—— 放根路径，发个链接就行 */
const DOWNLOAD_HTML = readPage("index.html");

/** 管理后台。**不放在根路径** —— 根路径给了下载页，管理员走 /admin */
const ADMIN_HTML = readPage("admin.html");
const ADMIN_PATHS = new Set(["/admin", "/admin/"]);

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown>;
  user: ServerUser | null;
  token: string | null;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────
// 请求体
// ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new HttpError(400, "请求体必须是 JSON 对象"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // 令牌是放在 Authorization 头里的（不是 Cookie），所以放开来源不会带来
    // CSRF 风险：别的网站拿不到令牌，也就冒充不了任何人。
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

// ─────────────────────────────────────────────────────────────
// 校验小工具（手写，不引 schema 库）
// ─────────────────────────────────────────────────────────────

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `缺少字段 ${key}`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `字段 ${key} 类型不对`);
  return value;
}

/** 公开的用户信息（**绝不含任何待办内容**） */
function publicUser(user: ServerUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    mustChangePassword: user.mustChangePassword,
  };
}

// ─────────────────────────────────────────────────────────────
// 应用
// ─────────────────────────────────────────────────────────────

export interface AppOptions {
  store: Store;
  /** 发布目录与对外域名。不传就没有下载页数据（接口返回空，页面显示"即将推出"） */
  releases?: ReleaseStore;
  /** 关闭登录限流（测试用） */
  disableRateLimit?: boolean;
}

export function createApp({ store, releases, disableRateLimit = false }: AppOptions): Server {
  /** 登录失败计数：`用户名` → { 次数, 窗口到期时刻 }。重启即清空，够用 */
  const failures = new Map<string, { count: number; resetAt: number }>();

  function checkRateLimit(username: string): void {
    if (disableRateLimit) return;
    const entry = failures.get(username);
    if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, "登录尝试过于频繁，请稍后再试");
    }
  }

  function noteFailure(username: string): void {
    if (disableRateLimit) return;
    const now = Date.now();
    const entry = failures.get(username);
    if (!entry || entry.resetAt <= now) {
      failures.set(username, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  async function route(ctx: Ctx): Promise<unknown> {
    const { url, body, user } = ctx;
    const path = url.pathname;
    const method = ctx.req.method ?? "GET";

    // ── 健康检查 ──
    if (method === "GET" && path === "/api/health") {
      return { ok: true };
    }

    // ── 发布下载页的数据（公开，不需要登录）──
    // 没有发布目录时也返回结构完整的空清单：页面要能优雅地显示"即将推出"，
    // 而不是转圈或者报错。
    if (method === "GET" && path === "/api/releases") {
      await releases?.refresh();
      return (
        releases?.publicListing() ?? {
          version: null,
          releasedAt: null,
          notes: null,
          platforms: [],
        }
      );
    }

    // ── 登录 ──
    if (method === "POST" && path === "/api/login") {
      const username = requireString(body, "username");
      const password = requireString(body, "password");
      checkRateLimit(username);

      const found = store.authenticate(username, password);
      if (!found) {
        noteFailure(username);
        // 不区分"没这个人"和"密码错"，避免被用来探测哪些账号存在
        throw new HttpError(401, "登录名或密码不对");
      }

      failures.delete(username);
      const token = store.issueToken(found.id, TOKEN_TTL_MS);
      return { token, user: publicUser(found) };
    }

    // 以下接口都要登录
    if (!user) throw new HttpError(401, "请先登录");

    // ── 当前用户 ──
    if (method === "GET" && path === "/api/me") {
      return { user: publicUser(user) };
    }

    // ── 退出 ──
    if (method === "POST" && path === "/api/logout") {
      if (ctx.token) store.revokeToken(ctx.token);
      return { ok: true };
    }

    // ── 改自己的密码 ──
    if (method === "POST" && path === "/api/password") {
      const oldPassword = requireString(body, "oldPassword");
      const newPassword = requireString(body, "newPassword");

      const problem = passwordProblem(newPassword);
      if (problem) throw new HttpError(400, problem);
      if (!store.authenticate(user.username, oldPassword)) {
        throw new HttpError(401, "原密码不对");
      }

      store.setPassword(user.id, newPassword, false);
      // 改密码会作废所有令牌（含当前这个），所以立刻发一个新的给本机
      const token = store.issueToken(user.id, TOKEN_TTL_MS);
      return { ok: true, token, user: publicUser({ ...user, mustChangePassword: false }) };
    }

    // ── 同步 ──
    if (method === "POST" && path === "/api/sync") {
      const request = body as unknown as SyncRequest;

      const push = Array.isArray(request.push) ? request.push : [];
      const cursor = Number.isFinite(request.cursor) ? Math.max(0, Number(request.cursor)) : 0;

      // ⚠️ 顺序是**先拉后推**，不能反过来。
      //
      // 如果先推后拉：客户端会把本地版本写上去，**覆盖掉另一台设备刚推的改动**，
      // 然后它拉回来的正是自己刚写的那份 —— 它永远不知道自己覆盖掉了什么，
      // 对方的改动就此消失（真实踩过的数据丢失）。
      // 先拉，客户端至少能看见对方改了什么，再按"后改的赢"自己裁决。
      const page = store.pull(user.id, cursor, request.limit);
      const { accepted, rejected } = store.push(user.id, push);

      return {
        ...page,
        accepted: accepted.length,
        rejected,
      };
    }

    // ─────────────────────────────────────────────────────────
    // 管理接口
    // ⚠️ 这里**永远不能**出现读取待办内容的接口。见文件顶部。
    // ─────────────────────────────────────────────────────────
    if (path.startsWith("/api/admin/")) {
      if (!user.isAdmin) throw new HttpError(403, "需要管理员权限");

      if (method === "GET" && path === "/api/admin/users") {
        return {
          users: store.listUsers().map((u) => ({
            ...publicUser(u),
            disabled: u.disabled,
            // 只给条数，不给内容 —— 管理员能知道"用起来了没"，但看不到写了什么
            recordCount: store.countRecords(u.id),
          })),
        };
      }

      if (method === "POST" && path === "/api/admin/users") {
        const password = requireString(body, "password");
        const problem = passwordProblem(password);
        if (problem) throw new HttpError(400, problem);

        const created = store.createUser({
          username: requireString(body, "username"),
          displayName: optionalString(body, "displayName") ?? "",
          password,
          isAdmin: body.isAdmin === true,
        });
        return { user: publicUser(created) };
      }

      // ─────────────────────────────────────────────────────────
      // 系统升级
      //
      // 只给管理员。Portainer 的 API Key 等同该主机的管理员权限
      // （CE 版没有细粒度权限），所以配置的读写都必须卡在这一层。
      // ─────────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/admin/upgrade") {
        const config = loadUpgradeConfig(store);
        return {
          currentVersion: process.env.KUAIBAN_VERSION ?? "未知",
          config: publicUpgradeConfig(config),
        };
      }

      if (method === "POST" && path === "/api/admin/upgrade/config") {
        const incoming = body.config as UpgradeConfig | undefined;
        if (!incoming || !Array.isArray(incoming.envs)) {
          throw new HttpError(400, "配置格式不对");
        }

        // 空字符串表示"这一项不动" —— 页面不会回显 Key，所以留空不能被当成"
        // 用户想清空"，否则每次保存设置都会把 Key 抹掉。
        const previous = loadUpgradeConfig(store);
        const merged: UpgradeConfig = {
          githubRepo: incoming.githubRepo ?? previous.githubRepo,
          githubToken: incoming.githubToken || previous.githubToken,
          envs: previous.envs.map((slot) => {
            const next = incoming.envs.find((e) => e.key === slot.key);
            if (!next) return slot;
            return {
              ...slot,
              ...next,
              apiKey: next.apiKey || slot.apiKey,
            };
          }),
        };
        saveUpgradeConfig(store, merged);
        return { config: publicUpgradeConfig(merged) };
      }

      if (method === "POST" && path === "/api/admin/upgrade/check") {
        // 点"检查更新"就该看到刚发布的东西，不能被 5 分钟缓存挡住
        await releases?.refresh(true);
        return await checkServerUpdate({
          config: loadUpgradeConfig(store),
          currentVersion: process.env.KUAIBAN_VERSION ?? "未知",
        });
      }

      if (method === "POST" && path === "/api/admin/upgrade/apply") {
        const config = loadUpgradeConfig(store);
        const target = config.envs.find((e) => e.key === body.env);
        if (!target) throw new HttpError(400, "没有这个环境");

        const version = typeof body.version === "string" ? body.version : "";
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HttpError(400, "版本号格式不对");

        return await applyUpgrade({
          env: target,
          version,
          imageName: typeof body.imageName === "string" && body.imageName
            ? body.imageName
            : process.env.KUAIBAN_IMAGE_NAME ?? "miaochi/kuaiban-server",
        });
      }

      const userPath = /^\/api\/admin\/users\/([^/]+)\/(password|disabled)$/.exec(path);
      if (userPath && method === "POST") {
        const targetId = decodeURIComponent(userPath[1]!);
        const action = userPath[2]!;

        // 防止管理员把自己锁在外面
        if (targetId === user.id && action === "disabled" && body.disabled === true) {
          throw new HttpError(400, "不能停用自己");
        }

        if (action === "password") {
          const password = requireString(body, "password");
          const problem = passwordProblem(password);
          if (problem) throw new HttpError(400, problem);
          store.setPassword(targetId, password, true);
          return { ok: true };
        }

        const target = store.findById(targetId);
        if (!target) throw new HttpError(404, "用户不存在");
        if (target.isAdmin && body.disabled === true && store.countActiveAdmins() <= 1) {
          throw new HttpError(400, "至少保留一个可用的管理员");
        }
        store.setDisabled(targetId, body.disabled === true);
        return { ok: true };
      }
    }

    throw new HttpError(404, "没有这个接口");
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "OPTIONS") {
          send(res, 204, {});
          return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");

        // 发布下载页（公开）
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          sendHtml(res, DOWNLOAD_HTML);
          return;
        }

        // 管理后台（静态，不需要登录态；里面的数据接口才需要）
        if (req.method === "GET" && ADMIN_PATHS.has(url.pathname)) {
          sendHtml(res, ADMIN_HTML);
          return;
        }

        // ── 安装包下载 ──
        const download = /^\/downloads\/(.+)$/.exec(url.pathname);
        if (req.method === "GET" && download) {
          // 不在本地就从 GitHub 取回来（同事的电脑连不上 GitHub，服务器能）
          const file = releases ? await releases.ensureAsset(decodeURIComponent(download[1]!)) : null;
          if (!file) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("没有这个文件");
            return;
          }
          const size = statSync(file).size;
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": size,
            "content-disposition": `attachment; filename="${encodeURIComponent(basename(file))}"`,
            "x-content-type-options": "nosniff",
          });
          createReadStream(file).pipe(res);
          return;
        }

        // ── 自动更新清单（Tauri 的格式，改不了）──
        if (req.method === "GET" && url.pathname === "/updates/latest.json") {
          const manifest = releases?.updaterManifest();
          if (!manifest) {
            send(res, 404, { error: "还没有发布任何版本" });
            return;
          }
          send(res, 200, manifest);
          return;
        }
        const body = req.method === "POST" ? await readBody(req) : {};

        // Bearer 令牌
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
        const user = token ? store.resolveToken(token) : null;

        const result = await route({ req, res, url, body, user, token });
        send(res, 200, result ?? { ok: true });
      } catch (err) {
        if (err instanceof HttpError) {
          send(res, err.status, { error: err.message });
          return;
        }
        if (err instanceof StoreError) {
          send(res, err.status, { error: err.message, code: err.code });
          return;
        }
        // 未预期的错误：日志里留全量，但**不要把内部细节回给客户端**
        console.error("[server] 未处理的错误", err);
        send(res, 500, { error: "服务器内部错误" });
      }
    })();
  });
}
