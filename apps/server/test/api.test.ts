/**
 * 服务端接口测试
 *
 * 刻意走**真实 HTTP**（起一个临时端口的真服务器 + fetch），而不是直接调函数：
 * 认证头、状态码、JSON 编解码这些地方出错，只有真发请求才测得出来。
 *
 * 两个重点：
 * 1. **两台设备能通过服务器同步到一起**（这是整个服务端存在的理由）
 * 2. **管理员绝对拿不到待办内容**（用"响应里不许出现敏感词"直接断言）
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPushTracker,
  runSync,
  type SyncResponse,
  type SyncTransport,
  type Todo,
} from "@kuaiban/core";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { Store } from "../src/store.ts";

let server: Server;
let base = "";
let store: Store;
let db: ReturnType<typeof openDatabase>;

beforeEach(async () => {
  db = openDatabase(":memory:");
  store = new Store(db);
  server = createApp({ store, disableRateLimit: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

// ─────────────────────────────────────────────────────────────
// 测试用的小客户端
// ─────────────────────────────────────────────────────────────

async function api(
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await api("/api/login", { body: { username, password } });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.token as string;
}

/** 建一个可用的普通用户，返回它的令牌 */
async function makeUser(adminToken: string, username: string, password = "userpass123") {
  const created = await api("/api/admin/users", {
    token: adminToken,
    body: { username, displayName: username, password },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return { token: await loginAs(username, password), id: created.json.user.id as string };
}

function makeAdmin(): string {
  store.createUser({ username: "boss", displayName: "老板", password: "bosspass123", isAdmin: true });
  return "";
}

function todo(over: Partial<Todo> & { id: string; updatedAt: string }): Todo {
  return {
    title: `待办 ${over.id}`,
    date: "2026-10-03",
    time: null,
    status: "pending",
    repeat: { kind: "none" },
    lastDoneDate: null,
    skippedDates: [],
    remind: false,
    remindBefore: 0,
    note: "",
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
    ...over,
  };
}

/**
 * 模拟**一台真实设备**：用大脑里的 `runSync` + 一个 fetch 传输层。
 *
 * 这正是桌面端将来要写的代码 —— 各平台唯一的差别就是这个传输函数
 * （桌面端换成 Tauri 的 HTTP，手机端换成各自的）。
 * 所以这组测试同时验证了两件事：服务端接口对，以及**这套协议真的能收敛**。
 */
class Device {
  local: Todo[] = [];
  cursor = 0;
  private readonly tracker = createPushTracker();

  constructor(private readonly token: string) {}

  private get transport(): SyncTransport {
    return async (request) => {
      const res = await api("/api/sync", { token: this.token, body: request });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json as SyncResponse;
    };
  }

  /** 本地写入（新建 / 编辑 / 完成 / 删除）：一律标记待上传 */
  write(...todos: Todo[]): void {
    for (const t of todos) {
      const at = this.local.findIndex((x) => x.id === t.id);
      if (at >= 0) this.local[at] = t;
      else this.local.push(t);
      this.tracker.markDirty(t.id);
    }
  }

  /** 跑一次完整同步（内部会自己来回几轮直到收敛） */
  async sync() {
    const result = await runSync({
      local: this.local,
      tracker: this.tracker,
      cursor: this.cursor,
      transport: this.transport,
    });
    this.local = result.local;
    this.cursor = result.cursor;
    return result;
  }

  /** 只拉不推（模拟一台只读的第三设备，比如新装的一台） */
  async pullOnly(): Promise<void> {
    const result = await runSync({
      local: this.local,
      tracker: createPushTracker(), // 空 → 什么都不会推
      cursor: this.cursor,
      transport: this.transport,
    });
    this.local = result.local;
    this.cursor = result.cursor;
  }

  get(id: string): Todo | undefined {
    return this.local.find((t) => t.id === id);
  }

  /** 活着的（没被删的）—— 用户真正看得见的那些 */
  alive(): Todo[] {
    return this.local.filter((t) => t.deletedAt === null);
  }
}

// ─────────────────────────────────────────────────────────────

describe("基础", () => {
  it("健康检查不需要登录", async () => {
    expect((await api("/api/health")).status).toBe(200);
  });

  it("没登录访问受保护接口 → 401", async () => {
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/sync", { body: { cursor: 0, push: [] } })).status).toBe(401);
  });

  it("登录名或密码不对 → 401，且不提示是哪个错（避免探测账号）", async () => {
    store.createUser({ username: "amy", displayName: "Amy", password: "amypass123" });

    const wrongPassword = await api("/api/login", { body: { username: "amy", password: "错的" } });
    const noSuchUser = await api("/api/login", { body: { username: "查无此人", password: "错的" } });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.json.error).toBe(noSuchUser.json.error);
  });

  it("停用的账号登不进来", async () => {
    store.createUser({ username: "amy", displayName: "Amy", password: "amypass123" });
    const amy = store.listUsers().find((u) => u.username === "amy")!;
    store.setDisabled(amy.id, true);

    expect((await api("/api/login", { body: { username: "amy", password: "amypass123" } })).status).toBe(401);
  });
});

describe("登录限流", () => {
  it("连续失败到上限后会被挡住", async () => {
    // 这个用例要开限流，单独起一个服务器
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApp({ store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    store.createUser({ username: "amy", displayName: "Amy", password: "amypass123" });

    for (let i = 0; i < 10; i++) {
      await api("/api/login", { body: { username: "amy", password: "错" } });
    }
    const blocked = await api("/api/login", { body: { username: "amy", password: "amypass123" } });

    expect(blocked.status).toBe(429);
  });
});

describe("账号", () => {
  it("管理员建号 → 新用户首次登录会被要求改密码", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");

    const created = await api("/api/admin/users", {
      token: admin,
      body: { username: "amy", displayName: "小美", password: "initpass123" },
    });
    expect(created.status).toBe(200);

    const amy = await loginAs("amy", "initpass123");
    const me = await api("/api/me", { token: amy });
    expect(me.json.user.mustChangePassword).toBe(true);
  });

  it("登录名不能重复", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    await api("/api/admin/users", { token: admin, body: { username: "amy", password: "initpass123" } });

    const again = await api("/api/admin/users", {
      token: admin,
      body: { username: "AMY", password: "initpass123" }, // 大小写不敏感
    });
    expect(again.status).toBe(409);
  });

  it("普通用户碰不到管理接口", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const { token: amy } = await makeUser(admin, "amy");

    expect((await api("/api/admin/users", { token: amy })).status).toBe(403);
    expect(
      (await api("/api/admin/users", { token: amy, body: { username: "x", password: "12345678" } })).status,
    ).toBe(403);
  });

  it("改密码之后旧令牌立刻失效（旧密码泄露时的止血）", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const { token: old } = await makeUser(admin, "amy");

    const changed = await api("/api/password", {
      token: old,
      body: { oldPassword: "userpass123", newPassword: "newpass12345" },
    });
    expect(changed.status).toBe(200);

    // 旧令牌不能再用
    expect((await api("/api/me", { token: old })).status).toBe(401);
    // 响应里给的新令牌可以用
    expect((await api("/api/me", { token: changed.json.token })).status).toBe(200);
    // 新密码能登录
    await expect(loginAs("amy", "newpass12345")).resolves.toBeTruthy();
  });

  it("管理员不能停用自己，也不能停用最后一个管理员", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const meRes = await api("/api/me", { token: admin });

    const self = await api(`/api/admin/users/${meRes.json.user.id}/disabled`, {
      token: admin,
      body: { disabled: true },
    });
    expect(self.status).toBe(400);
  });

  it("弱密码建号会被拒绝", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const res = await api("/api/admin/users", {
      token: admin,
      body: { username: "amy", password: "123" },
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────
// 核心场景：两台设备
// ─────────────────────────────────────────────────────────────

describe("两台设备通过服务器同步", () => {
  let amyToken: string;

  beforeEach(async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    amyToken = (await makeUser(admin, "amy")).token;
  });

  it("A 建的待办，B 能同步到", async () => {
    const a = new Device(amyToken);
    const b = new Device(amyToken);

    a.write(todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "交周报" }));
    expect((await a.sync()).rejected).toHaveLength(0);

    await b.sync();
    expect(b.alive().map((t) => t.title)).toEqual(["交周报"]);
  });

  it("B 改的，A 能增量拉到（只拉变化的那条）", async () => {
    const a = new Device(amyToken);
    const b = new Device(amyToken);

    const t1 = todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "原文" });
    const t2 = todo({ id: "t2", updatedAt: "2026-10-03T10:00:00.000Z", title: "没动的" });
    a.write(t1, t2);
    await a.sync();

    // B 是**从服务器拉下来**这两条的（不是自己写的），所以它并不"脏"
    await b.sync();
    expect(b.alive()).toHaveLength(2);

    // B 只改 t1
    b.write({ ...t1, title: "改过了", updatedAt: "2026-10-03T11:00:00.000Z" });
    await b.sync();

    // A 这一趟只应该拉到 t1 的「变化」（t2 没动就不该再发一次）
    const res = await api("/api/sync", { token: amyToken, body: { cursor: a.cursor, push: [] } });
    expect(res.json.pull).toHaveLength(1);
    expect(res.json.pull[0].id).toBe("t1");

    await a.sync();
    expect(a.get("t1")!.title).toBe("改过了");
  });

  it("更新已有记录后游标必须前进（否则另一台设备永远拉不到这次修改）", async () => {
    const a = new Device(amyToken);
    const t1 = todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z" });
    a.write(t1);
    await a.sync();
    const cursorAfterFirst = a.cursor;

    // 原地更新（id 不变）—— 若服务端复用旧 seq，带着已超过它的游标来拉就永远看不到
    a.write({ ...t1, title: "第二次", updatedAt: "2026-10-03T12:00:00.000Z" });
    await a.sync();

    const res = await api("/api/sync", { token: amyToken, body: { cursor: cursorAfterFirst, push: [] } });
    expect(res.json.pull).toHaveLength(1);
    expect(res.json.cursor).toBeGreaterThan(cursorAfterFirst);
  });

  it("删除会同步过去，别处不会把它复活", async () => {
    const a = new Device(amyToken);
    const b = new Device(amyToken);

    const t1 = todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "要删的" });
    a.write(t1);
    await a.sync();

    b.write(t1);
    await b.sync();
    expect(b.alive()).toHaveLength(1);

    a.write({ ...t1, deletedAt: "2026-10-03T11:00:00.000Z", updatedAt: "2026-10-03T11:00:00.000Z" });
    await a.sync();
    await b.sync();

    expect(b.alive()).toHaveLength(0);
  });

  it("两台设备最终收敛到同一份（含冲突：后改的赢）", async () => {
    const a = new Device(amyToken);
    const b = new Device(amyToken);

    const base1 = todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "同一个" });
    a.write(base1);
    await a.sync();
    b.write(base1);
    await b.sync();

    // 两边同时改同一条，A 改得更晚
    a.write({ ...base1, title: "A 的版本", updatedAt: "2026-10-03T12:00:00.000Z" });
    b.write({ ...base1, title: "B 的版本", updatedAt: "2026-10-03T11:00:00.000Z" });

    // 各同步一次就应当收敛（runSync 内部会自己多跑几轮）
    await a.sync();
    await b.sync();

    expect(a.get("t1")!.title).toBe("A 的版本"); // 后改的赢
    expect(b.get("t1")!.title).toBe("A 的版本");
    expect(a.get("t1")!.title).toBe(b.get("t1")!.title);
  });

  it("收敛不靠运气：来回同步十轮也不会来回翻烧饼", async () => {
    const a = new Device(amyToken);
    const b = new Device(amyToken);

    const t1 = todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "初版" });
    a.write(t1);
    await a.sync();
    b.write(t1);
    await b.sync();

    a.write({ ...t1, title: "A", updatedAt: "2026-10-03T12:00:00.000Z" });
    b.write({ ...t1, title: "B", updatedAt: "2026-10-03T11:00:00.000Z" });

    for (let i = 0; i < 10; i++) {
      await a.sync();
      await b.sync();
      // 每一轮都必须一致 —— 不能出现"A 赢一轮、B 赢一轮"的翻烧饼
      expect(a.get("t1")!.title).toBe("A");
      expect(b.get("t1")!.title).toBe("A");
    }
  });

  it("两个用户的数据互不可见", async () => {
    const admin = await loginAs("boss", "bosspass123");
    const ben = new Device((await makeUser(admin, "ben")).token);
    const amy = new Device(amyToken);

    amy.write(todo({ id: "secret", updatedAt: "2026-10-03T10:00:00.000Z", title: "Amy 的事" }));
    await amy.sync();

    await ben.sync();
    expect(ben.local).toHaveLength(0);
  });

  it("超长内容会被拒绝并如实回报（不能静默丢）", async () => {
    const a = new Device(amyToken);
    a.write(todo({ id: "bomb", updatedAt: "2026-10-03T10:00:00.000Z", note: "x".repeat(70_000) }));

    const result = await a.sync();
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("bomb");
    // 被拒的记录不能悄悄消失：标记还留着，下次同步会再试
    expect(a.get("bomb")).toBeDefined();

    // 而且服务端上确实没有这条
    const other = new Device(amyToken);
    await other.sync();
    expect(other.local).toHaveLength(0);
  });

  it("只读设备也能拉到全部数据", async () => {
    const writer = new Device(amyToken);
    writer.write(
      todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: "一" }),
      todo({ id: "t2", updatedAt: "2026-10-03T10:00:00.000Z", title: "二" }),
    );
    await writer.sync();

    const reader = new Device(amyToken);
    await reader.pullOnly();
    expect(reader.alive().map((t) => t.title).sort()).toEqual(["一", "二"]);
  });
});

// ─────────────────────────────────────────────────────────────
// 隐私：这是产品承诺，用断言钉死
// ─────────────────────────────────────────────────────────────

describe("管理员看不到待办内容", () => {
  it("管理员接口的响应里不允许出现任何待办内容", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const { token: amy, id: amyId } = await makeUser(admin, "amy");

    const SECRET = "银行卡密码是1234";
    const amyDevice = new Device(amy);
    amyDevice.write(todo({ id: "t1", updatedAt: "2026-10-03T10:00:00.000Z", title: SECRET }));
    await amyDevice.sync();

    const users = await api("/api/admin/users", { token: admin });
    const raw = JSON.stringify(users.json);

    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("银行卡");
    // 但管理员能知道"这个人用起来了"（条数）
    expect(users.json.users.find((u: any) => u.id === amyId).recordCount).toBe(1);
  });

  it("没有「看某人待办」的接口 —— 连调试用的都不留", async () => {
    makeAdmin();
    const admin = await loginAs("boss", "bosspass123");
    const { id: amyId } = await makeUser(admin, "amy");

    for (const path of [
      `/api/admin/users/${amyId}/todos`,
      `/api/admin/todos`,
      `/api/todos`,
      `/api/admin/users/${amyId}/records`,
    ]) {
      expect((await api(path, { token: admin })).status, path).toBe(404);
    }
  });
});
