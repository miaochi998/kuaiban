/**
 * 同步 store 的集成测试
 *
 * 测的是**外壳那层接线**：登录态 → 脏数据怎么算 → 落盘 → 下次不再重复推。
 * 同步规则本身（合并、冲突）在大脑里已经测过了，服务端接口另有真实 HTTP 测试；
 * 这里补的是中间那一段 —— 它出问题时的表现是"看起来同步了，其实没同步"。
 *
 * 跑在纯 Node 下：用一个内存假服务端接住 fetch，不需要浏览器，也不需要 Tauri。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTodoRepository, type Todo } from "@kuaiban/core";

// ─────────────────────────────────────────────────────────────
// 最小可用的 localStorage
// ─────────────────────────────────────────────────────────────

function installLocalStorage(): void {
  const box = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => void box.set(k, v),
    removeItem: (k: string) => void box.delete(k),
    clear: () => box.clear(),
  };
}

// ─────────────────────────────────────────────────────────────
// 内存假服务端（行为与真服务端一致：先拉后推、每条写入分配新 seq）
// ─────────────────────────────────────────────────────────────

interface FakeUser {
  password: string;
  user: { id: string; username: string; displayName: string; isAdmin: boolean; mustChangePassword: boolean };
}

function fakeServer() {
  const users = new Map<string, FakeUser>();
  users.set("amy", {
    password: "amypass123",
    user: {
      id: "user-amy",
      username: "amy",
      displayName: "小美",
      isAdmin: false,
      mustChangePassword: false,
    },
  });

  /** userId → (待办 id → 记录) */
  const rows = new Map<string, Map<string, { payload: string; updatedAt: string; deletedAt: string | null; seq: number }>>();
  let seq = 0;
  let syncCalls = 0;
  let pushed = 0;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (url.endsWith("/api/login")) {
      const found = users.get(String(body.username));
      if (!found || found.password !== body.password) {
        return json(401, { error: "登录名或密码不对" });
      }
      return json(200, { token: `token-${found.user.id}`, user: found.user });
    }

    if (url.endsWith("/api/logout")) return json(200, { ok: true });

    if (url.endsWith("/api/sync")) {
      const userId = token.replace("token-", "");
      if (!users.has(userId === "user-amy" ? "amy" : userId)) return json(401, { error: "请先登录" });

      syncCalls += 1;
      const store = rows.get(userId) ?? new Map();
      rows.set(userId, store);

      // 先拉后推（与真服务端一致）
      const pull = [...store.entries()]
        .filter(([, r]) => r.seq > Number(body.cursor ?? 0))
        .sort((a, b) => a[1].seq - b[1].seq)
        .map(([id, r]) => ({ id, ...r }));

      const cursor = pull.length > 0 ? pull[pull.length - 1]!.seq : Number(body.cursor ?? 0);

      for (const item of (body.push ?? []) as { id: string; payload: string; updatedAt: string; deletedAt: string | null }[]) {
        seq += 1;
        pushed += 1;
        store.set(item.id, {
          payload: item.payload,
          updatedAt: item.updatedAt,
          deletedAt: item.deletedAt,
          seq,
        });
      }

      return json(200, { pull, cursor, hasMore: false, rejected: [] });
    }

    return json(404, { error: "没有这个接口" });
  };

  return {
    fetchImpl,
    calls: () => syncCalls,
    pushedCount: () => pushed,
    // 注意：这里必须"取不到就建一个并存回去"。
    // 直接 `?? new Map()` 会返回一个临时表，往里塞的东西下一行就没了 ——
    // 我第一版就是这么写的，然后花了十分钟怀疑同步逻辑。
    serverRows: (userId: string) => {
      if (!rows.has(userId)) rows.set(userId, new Map());
      return rows.get(userId)!;
    },
  };
}

function makeTodo(over: Partial<Todo> & { id: string }): Todo {
  const now = "2026-10-04T00:00:00.000Z";
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

async function setup(preloaded: Todo[] = []) {
  installLocalStorage();
  const server = fakeServer();
  (globalThis as { fetch?: unknown }).fetch = server.fetchImpl;

  // 先把数据放进仓储，再初始化 store —— initTodoStore 自己会读一遍
  const repo = new MemoryTodoRepository();
  if (preloaded.length > 0) await repo.upsert([...preloaded]);

  vi.resetModules();
  const todosMod = await import("../src/store/todos");
  await todosMod.initTodoStore(repo);
  const accountMod = await import("../src/store/account");
  const syncMod = await import("../src/store/sync");

  // 状态要通过 store 钩子拿（模块只导出动作与钩子）
  return {
    server,
    repo,
    todos: todosMod.useTodoStore(),
    account: accountMod.useAccountStore(),
    sync: syncMod.useSyncStore(),
  };
}

beforeEach(() => {
  installLocalStorage();
});

describe("离线优先的底线", () => {
  it("没登录时同步什么都不做，也不会报错", async () => {
    const { sync, server, todos } = await setup([makeTodo({ id: "t1" })]);

    await sync.syncNow();

    expect(server.calls()).toBe(0);
    expect(todos.todos.value).toHaveLength(1); // 本地一切照常
    expect(sync.status.value.state).toBe("offline");
  });

  it("没登录时本地改动照样算「待上传」，但不会去连服务器", async () => {
    const { sync, todos, server } = await setup();
    await todos.addTodo({ title: "断网也要能记", date: "2026-10-03" });

    expect(server.calls()).toBe(0);
    expect(sync.pendingCount.value).toBe(1);
  });
});

describe("登录之后", () => {
  it("首次登录会把本地已有的待办带上去（用户不用手工搬）", async () => {
    const { account, sync, server } = await setup([makeTodo({ id: "local-1" })]);

    expect(await account.login("amy", "amypass123")).toBe(true);
    await sync.syncNow();

    expect(server.serverRows("user-amy").size).toBe(1);
    expect(sync.status.value.state).toBe("synced");
  });

  it("已经推上去的不会每轮重复推", async () => {
    const { account, sync, server } = await setup([makeTodo({ id: "local-1" })]);
    await account.login("amy", "amypass123");

    await sync.syncNow();
    const afterFirst = server.pushedCount();
    await sync.syncNow();
    await sync.syncNow();

    expect(server.pushedCount()).toBe(afterFirst); // 后面两轮一条都没推
  });

  it("本地改动之后会被重新推上去", async () => {
    const { account, sync, todos, server } = await setup([makeTodo({ id: "local-1" })]);
    await account.login("amy", "amypass123");
    await sync.syncNow();
    const before = server.pushedCount();

    await todos.editTodo(todos.todos.value[0]!, { title: "改过了" });
    await sync.syncNow();

    expect(server.pushedCount()).toBe(before + 1);
    const row = server.serverRows("user-amy").get("local-1")!;
    expect(JSON.parse(row.payload).title).toBe("改过了");
  });

  it("服务端上的改动会落进本地", async () => {
    const { account, sync, server, todos } = await setup();
    await account.login("amy", "amypass123");

    // 别的设备推了一条上去
    server.serverRows("user-amy").set("from-phone", {
      payload: JSON.stringify(makeTodo({ id: "from-phone", title: "手机上加的" })),
      updatedAt: "2026-10-04T01:00:00.000Z",
      deletedAt: null,
      seq: 99,
    });

    await sync.syncNow();

    expect(todos.todos.value.map((t) => t.title)).toContain("手机上加的");
  });

  it("同步失败不影响本地数据（离线优先）", async () => {
    const { account, sync, todos } = await setup([makeTodo({ id: "t1" })]);
    await account.login("amy", "amypass123");

    (globalThis as { fetch?: unknown }).fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await sync.syncNow();

    expect(sync.status.value.state).toBe("error");
    expect(sync.lastError.value).toContain("连不上服务器");
    expect(todos.todos.value).toHaveLength(1); // 本地一条没少
    expect(sync.pendingCount.value).toBe(1); // 还记着"没传上去"
  });
});

describe("账号安全边界", () => {
  it("本地数据属于别的账号时，拒绝推送并给出提示（绝不把上一个人的待办传上去）", async () => {
    const { account, sync, server } = await setup([makeTodo({ id: "t1" })]);
    await account.login("amy", "amypass123");
    await sync.syncNow(); // ownerId = user-amy
    const pushedBefore = server.pushedCount();

    // 换一个账号登录
    await account.logout();
    // 假服务端里再加一个人
    (globalThis as any).fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/login")) {
        return new Response(
          JSON.stringify({
            token: "token-user-ben",
            user: { id: "user-ben", username: "ben", displayName: "小本", isAdmin: false, mustChangePassword: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return (server.fetchImpl as any)(input, init);
    };

    await account.login("ben", "benpass123");
    sync.startSync();
    await sync.syncNow();

    expect(sync.conflictOwner.value).toBe("user-amy"); // 明确告诉用户
    expect(server.pushedCount()).toBe(pushedBefore); // 一条都没往新账号推
  });
});
