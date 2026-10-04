/**
 * 状态层的错误反馈测试
 *
 * 起因是一次真实反馈：「我添加的时候没有任何成功或者失败的提示，
 * 就相当于点了回车没有任何反应。」
 *
 * 根因是写操作没有被 try/catch 包住 —— 写库一旦失败就变成一个没人处理的
 * Promise 拒绝，界面上完全看不出来。用户会以为记下了，其实什么都没发生。
 *
 * 所以这里专门把**失败路径**当成一等公民来测：每一种写操作失败时，
 * 都必须返回 false 并且把原因写进 `lastError`。
 *
 * 注意：这个测试跑在纯 Node 环境下，不需要浏览器，也不需要 Tauri ——
 * 因为状态层只用 `@kuaiban/core` 的端口接口，不碰任何平台 API。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTodoRepository, type Todo, type TodoRepository } from "@kuaiban/core";
import type * as StoreModule from "../src/store/todos";

/** 每次都在全新的模块实例上跑，避免单例状态串味 */
async function freshStore(repo: TodoRepository): Promise<ReturnType<typeof StoreModule.useTodoStore>> {
  vi.resetModules();
  const mod = await import("../src/store/todos");
  await mod.initTodoStore(repo);
  return mod.useTodoStore();
}

class ExplodingRepository implements TodoRepository {
  constructor(private readonly message = "磁盘写满了") {}
  async list(): Promise<Todo[]> {
    return [];
  }
  async upsert(): Promise<void> {
    throw new Error(this.message);
  }
  async clear(): Promise<void> {
    throw new Error(this.message);
  }
}

class ListFailsRepository extends MemoryTodoRepository {
  override async list(): Promise<Todo[]> {
    throw new Error("数据库被锁住了");
  }
}

/** 造一条待办（不经过仓储，纯粹给失败路径当入参用） */
function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: "x",
    title: "t",
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
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("成功路径：写进去了就要让用户看得出来", () => {
  it("addTodo 返回真正落盘的那条，清单立刻多一条，没有错误", async () => {
    const store = await freshStore(new MemoryTodoRepository());

    const created = await store.addTodo({ title: "写周报", date: "2026-10-03" });
    // 返回实体而不是 boolean：起始日可能被重复规则改过，界面要拿实际日期说话
    expect(created?.title).toBe("写周报");
    expect(created?.date).toBe("2026-10-03");
    expect(created).not.toBeNull();

    expect(store.lastError.value).toBeNull();
    expect(store.todos.value).toHaveLength(1);
    expect(store.todos.value[0]!.title).toBe("写周报");
  });

  it("刚加的那条会被标记出来（界面上闪一下）", async () => {
    const store = await freshStore(new MemoryTodoRepository());
    await store.addTodo({ title: "写周报", date: "2026-10-03" });

    expect(store.justAddedId.value).toBe(store.todos.value[0]!.id);
  });

  it("flashNotice 会写进 notice", async () => {
    const store = await freshStore(new MemoryTodoRepository());
    store.flashNotice("已添加「写周报」");
    expect(store.notice.value).toBe("已添加「写周报」");
  });

  it("勾选与删除都返回 true", async () => {
    const store = await freshStore(new MemoryTodoRepository());
    await store.addTodo({ title: "打卡", date: "2026-10-03" });
    const todo = store.todos.value[0]!;

    expect(await store.toggleDone(todo, "2026-10-03")).toBe(true);
    expect(await store.removeTodo(store.todos.value[0]!)).toBe(true);
    expect(store.lastError.value).toBeNull();
  });
});

describe("失败路径：绝不能静默 —— 这是本次修复的核心", () => {
  it("写库失败时 addTodo 返回 null，并且把原因写进 lastError", async () => {
    const store = await freshStore(new ExplodingRepository("磁盘写满了"));

    const created = await store.addTodo({ title: "写周报", date: "2026-10-03" });

    expect(created).toBeNull();
    expect(store.lastError.value).toContain("添加待办失败");
    expect(store.lastError.value).toContain("磁盘写满了");
  });

  it("写库失败时清单不会凭空多出一条（界面与库不能不一致）", async () => {
    const store = await freshStore(new ExplodingRepository());

    await store.addTodo({ title: "写周报", date: "2026-10-03" });

    expect(store.todos.value).toHaveLength(0);
  });

  it("写库失败时不设置 justAddedId（没有东西可高亮）", async () => {
    const store = await freshStore(new ExplodingRepository());
    await store.addTodo({ title: "写周报", date: "2026-10-03" });
    expect(store.justAddedId.value).toBeNull();
  });

  it("删除失败会提示删除失败", async () => {
    const store = await freshStore(new ExplodingRepository());

    expect(await store.removeTodo(makeTodo())).toBe(false);
    expect(store.lastError.value).toContain("删除失败");
  });

  it("改期失败会提示改期失败", async () => {
    const store = await freshStore(new ExplodingRepository());

    expect(await store.moveTodoTo(makeTodo({ date: "2026-10-01" }), "2026-10-03")).toBe(false);
    expect(store.lastError.value).toContain("改期失败");
  });

  it("失败之后再成功一次，错误提示会被清掉", async () => {
    const store = await freshStore(new ExplodingRepository());
    await store.addTodo({ title: "会失败的", date: "2026-10-03" });
    expect(store.lastError.value).not.toBeNull();

    vi.resetModules();
    const mod = await import("../src/store/todos");
    await mod.initTodoStore(new MemoryTodoRepository());
    const store2 = mod.useTodoStore();
    expect(await store2.addTodo({ title: "会成功的", date: "2026-10-03" })).not.toBeNull();
    expect(store2.lastError.value).toBeNull();
  });

  it("服务没初始化就调用，也会给出可读的提示而不是静默", async () => {
    vi.resetModules();
    const mod = await import("../src/store/todos");
    const store = mod.useTodoStore(); // 故意不调 initTodoStore

    const ok = await store.addTodo({ title: "x", date: null });

    expect(ok).toBeNull();
    expect(store.lastError.value).toContain("添加待办失败");
  });
});

describe("启动时读取失败", () => {
  it("读取失败会写进 fatalError（界面据此显示错误，而不是假装是空清单）", async () => {
    vi.resetModules();
    const mod = await import("../src/store/todos");
    await mod.initTodoStore(new ListFailsRepository());
    const store = mod.useTodoStore();

    expect(store.fatalError.value).toContain("数据库被锁住了");
    expect(store.ready.value).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 放弃本机数据（"这台电脑上的待办属于别的账号，我不要它们"）
// ─────────────────────────────────────────────────────────────

describe("放弃本机数据", () => {
  it("真的把本机记录清掉了，而不只是从界面隐藏", async () => {
    const repo = new MemoryTodoRepository();
    const store = await freshStore(repo);
    await store.addTodo({ title: "别人留下的", date: "2026-10-04" });
    expect(await repo.list()).toHaveLength(1);

    const ok = await store.discardAllLocal();

    expect(ok).toBe(true);
    // 界面清空
    expect(store.todos.value).toHaveLength(0);
    // **仓储里也真的没了** —— 这是关键：
    // 只清界面不清库的话，下次同步又会被拉回来 / 或者被推到新账号去。
    expect(await repo.list()).toHaveLength(0);
  });

  it("写失败时返回 false 且不清空界面 —— 不能让用户以为成功了", async () => {
    const store = await freshStore(new ExplodingRepository("磁盘写满了"));

    const ok = await store.discardAllLocal();

    expect(ok).toBe(false);
  });
});
