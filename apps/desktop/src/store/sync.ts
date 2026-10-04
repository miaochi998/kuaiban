/**
 * 同步引擎（外壳层）
 *
 * 规则全在大脑里（`@kuaiban/core` 的 `runSync` / `mergeTodos`）；
 * 这里只负责三件**平台相关**的事：
 *
 * 1. **传输**：用 webview 的 fetch 打真实的 HTTP
 * 2. **持久化**：游标、"哪些已经推上去过"，存本地
 * 3. **触发时机**：启动后、改动后、定时、手动
 *
 * ## 怎么判断"哪些需要推"
 *
 * 不用内存里的标记，而是**记录每条待办上次成功推上去的 `updatedAt`**：
 *
 *     脏 = 当前 updatedAt ≠ 上次推上去的 updatedAt（或从没推过）
 *
 * 好处是**自愈**：本地状态丢了也不怕，下次同步会把对不上的全推一遍，
 * 之后自动恢复正常。用内存标记的话，一旦丢失，用户的改动就永远同步不出去了。
 */

import { computed, ref, watch } from "vue";
import {
  createPushTracker,
  runSync,
  type SyncResponse,
  type SyncStatus,
  type Todo,
} from "@kuaiban/core";
import { apiFetch, useAccountStore } from "./account";
import { useTodoStore } from "./todos";

const STATE_KEY_PREFIX = "kuaiban.sync.v1.";

/**
 * 「这台电脑上的待办属于哪个账号」。
 *
 * ⚠️ 这个必须**全局存一份**，不能跟着每个用户的同步状态走。
 * 一开始我把它放进了 per-user 的 state 里，结果是：换个账号登录时读的是新账号的状态，
 * ownerId 自然等于新账号 —— 冲突检查永远不会触发，
 * **上一个人的待办会被原样推到新账号上去**（测试抓到的）。
 */
const OWNER_KEY = "kuaiban.sync.owner.v1";

/** 定时同步间隔。改动后还有一次更快的触发，所以这个可以放宽 */
const AUTO_SYNC_MS = 3 * 60_000;

/** 本地改动后多久触发一次同步（防抖，避免打一串字同步十次） */
const AFTER_CHANGE_MS = 4_000;

export interface SyncState {
  cursor: number;
  /** 待办 id → 上次成功推上去的 updatedAt */
  pushedAt: Record<string, string>;
}

/** 这台电脑上的本地数据属于哪个账号（null = 还没归属过） */
const ownerId = ref<string | null>(loadOwner());

function loadOwner(): string | null {
  try {
    return globalThis.localStorage?.getItem(OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveOwner(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(OWNER_KEY, id);
    else globalThis.localStorage?.removeItem(OWNER_KEY);
  } catch {
    /* 存不下的话下次会当成"还没归属过"，最坏情况是多推一遍，不会串账号 */
  }
}

const account = useAccountStore();
const todoStore = useTodoStore();

const state = ref<SyncState>({ cursor: 0, pushedAt: {} });
const running = ref(false);
const lastError = ref<string | null>(null);
const lastSyncedAt = ref<string | null>(null);

/** 本地数据属于别的账号 —— 绝不能把上一个人的待办推到新账号上去 */
const conflictOwner = ref<string | null>(null);

const pendingCount = computed(() => {
  const pushedAt = state.value.pushedAt;
  return todoStore.todos.value.filter((t) => pushedAt[t.id] !== t.updatedAt).length;
});

const state_ = computed<"synced" | "syncing" | "offline" | "error">(() => {
  if (lastError.value) return "error";
  if (running.value) return "syncing";
  if (!account.loggedIn.value) return "offline";
  return "synced";
});

const status = computed<SyncStatus>(() => ({
  state: state_.value,
  pendingCount: pendingCount.value,
  lastSyncedAt: lastSyncedAt.value,
}));

// ─────────────────────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────────────────────

function keyFor(userId: string): string {
  return `${STATE_KEY_PREFIX}${userId}`;
}

function loadState(userId: string): SyncState {
  try {
    const raw = globalThis.localStorage?.getItem(keyFor(userId));
    if (!raw) return { cursor: 0, pushedAt: {} };
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      cursor: typeof parsed.cursor === "number" ? parsed.cursor : 0,
      pushedAt: parsed.pushedAt && typeof parsed.pushedAt === "object" ? parsed.pushedAt : {},
    };
  } catch {
    return { cursor: 0, pushedAt: {} };
  }
}

function saveState(userId: string): void {
  try {
    globalThis.localStorage?.setItem(keyFor(userId), JSON.stringify(state.value));
  } catch {
    // 存不下就退化成"下次全推一遍" —— 慢一点，但不会丢东西
  }
}

// ─────────────────────────────────────────────────────────────
// 同步
// ─────────────────────────────────────────────────────────────

let autoTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let watcher: ReturnType<typeof watch> | null = null;

/**
 * 正在把"服务端来的改动"写进本地。
 *
 * 用来避免**同步触发同步**：applySynced 会替换 todos 数组，
 * 而下面的 watch 会因此再安排一次同步 —— 一次同步变成一直同步。
 */
let applyingRemote = false;

/** 把服务端来的结果写进本地，且不因此触发新一轮同步 */
async function applyRemote(merged: readonly Todo[]): Promise<void> {
  applyingRemote = true;
  try {
    await todoStore.applySynced(merged);
  } finally {
    applyingRemote = false;
  }
}

export async function syncNow(): Promise<void> {
  const user = account.user.value;
  if (!user || running.value) return;

  // 本地数据属于别的账号：停下来说清楚，绝不硬推
  if (ownerId.value && ownerId.value !== user.id) {
    conflictOwner.value = ownerId.value;
    return;
  }
  if (conflictOwner.value) return;

  running.value = true;
  lastError.value = null;

  try {
    const pushedAt = state.value.pushedAt;
    const local = todoStore.todos.value;

    // 脏 = 当前 updatedAt 与"上次推上去的"对不上
    const dirtyIds = local.filter((t) => pushedAt[t.id] !== t.updatedAt).map((t) => t.id);
    const tracker = createPushTracker(dirtyIds);

    const result = await runSync({
      local,
      tracker,
      cursor: state.value.cursor,
      transport: (request) => apiFetch<SyncResponse>("/api/sync", { body: request }),
    });

    // 落盘：只写真正变化的那些，别每次同步把整库重写一遍
    await applyRemote(result.local);

    // 记账：还留在 tracker 里的 = 这次没推成功的（比如被服务端拒收），保持"脏"
    const stillDirty = new Set(tracker.pending());
    const nextPushedAt: Record<string, string> = {};
    for (const todo of result.local) {
      const previous = pushedAt[todo.id];
      nextPushedAt[todo.id] = stillDirty.has(todo.id) ? (previous ?? "") : todo.updatedAt;
    }

    state.value = { cursor: result.cursor, pushedAt: nextPushedAt };
    ownerId.value = user.id;
    saveOwner(user.id);
    saveState(user.id);
    lastSyncedAt.value = new Date().toISOString();

    // 出问题不能静默。被拒和"读不出来"是两件事，可能同时发生，所以拼在一起说。
    const notices: string[] = [];
    if (result.rejected.length > 0) {
      notices.push(`有 ${result.rejected.length} 条没能上传（${result.rejected[0]!.reason}）`);
    }
    // 服务端有读不出来的记录（字段不全、版本不兼容等）。
    // 这些会被跳过、**不影响其他记录同步**，但用户有权知道少了东西 ——
    // 静默消失比报错更难排查。
    if (result.broken.length > 0) {
      notices.push(`有 ${result.broken.length} 条数据读不出来，已跳过（${result.broken[0]!.reason}）`);
    }
    if (notices.length > 0) lastError.value = notices.join("；");
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : "同步失败";
  } finally {
    running.value = false;
  }
}

/** 本地改动之后安排一次同步（防抖，别打一个字同步一次） */
export function scheduleSync(): void {
  if (applyingRemote) return; // 见 applyingRemote 的说明
  if (!account.loggedIn.value || conflictOwner.value) return;
  if (changeTimer !== null) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    void syncNow();
  }, AFTER_CHANGE_MS);
}

export function startSync(): void {
  const user = account.user.value;
  if (user) {
    state.value = loadState(user.id);
    // 本地数据属于别的账号 → 不自动同步，等用户处理
    if (ownerId.value && ownerId.value !== user.id) {
      conflictOwner.value = ownerId.value;
      return;
    }
  }

  // 本地一改就安排一次同步。
  // flush: "sync" 是必须的 —— 这样 applySynced 替换数组时 watcher 是**同步**触发的，
  // applyingRemote 那个开关才来得及拦住它（默认的异步 flush 拦不住）。
  if (watcher === null) {
    watcher = watch(todoStore.todos, () => scheduleSync(), { flush: "sync" });
  }

  if (autoTimer !== null) return;
  void syncNow();
  autoTimer = setInterval(() => void syncNow(), AUTO_SYNC_MS);
}

export function stopSync(): void {
  // 退出登录时冲突状态必须一起清掉。
  // 否则会出现自相矛盾的界面：上面写着"未登录 —— 数据只在这台电脑上"，
  // 下面却还挂着"这台电脑上的待办属于另一个账号"。
  conflictOwner.value = null;

  if (watcher !== null) {
    watcher();
    watcher = null;
  }
  if (autoTimer !== null) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (changeTimer !== null) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
}

/**
 * 换了账号：把本地这份数据"过户"给新账号。
 *
 * 只在用户**明确确认**后调用 —— 默认绝不这么做，
 * 否则上一个人的待办就被推到新账号里去了。
 */
export function adoptLocalDataFor(userId: string): void {
  state.value = { cursor: 0, pushedAt: {} };
  ownerId.value = userId;
  saveOwner(userId);
  saveState(userId);
  conflictOwner.value = null;
  void syncNow();
}

/**
 * 换了账号：**放弃**本机这份属于上一个账号的数据。
 *
 * 和 `adoptLocalDataFor`（过户）相对。有些场景用户根本不想要旧数据 ——
 * 比如这台电脑上留的是测试数据、或者前一个使用者已经离职。
 * 少了这条路，用户会被卡在"只能把别人的东西搬进自己账号"这一个选项上。
 *
 * 做法是**真的从本机删掉**，而不是软删除：软删除会把这些待办标记为已删
 * 再同步出去，反而会去改另一个账号的数据。
 */
export function discardLocalData(userId: string): void {
  void (async () => {
    const ok = await todoStore.discardAllLocal();
    if (!ok) return; // 清空失败就保持冲突状态，别假装成功了

    // 游标和推送记录一起清掉：本机已经什么都没了，
    // 留着旧游标只会让下一次同步去拉一份"别人的历史"。
    state.value = { cursor: 0, pushedAt: {} };
    ownerId.value = userId;
    saveOwner(userId);
    saveState(userId);
    conflictOwner.value = null;
    void syncNow();
  })();
}

export function useSyncStore() {
  return {
    status,
    pendingCount,
    lastError,
    conflictOwner,
    syncNow,
    startSync,
    stopSync,
    adoptLocalDataFor,
    discardLocalData,
  };
}

export type { Todo };
