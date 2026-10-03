/**
 * 同步 —— 协议与合并规则
 *
 * ## 为什么同步逻辑在大脑里，而不是在服务端
 *
 * 服务端**不理解待办**。它只是一个"按用户分区的、只能追加更新的记录仓库"：
 * 存 id、时间戳、软删除标记，以及一坨它看不懂的 `payload`。
 *
 * 这么做有三个好处：
 * 1. **隐私**：服务端（以及能登进数据库的管理员）看到的是密文，看不到内容
 * 2. **架构一致**：业务规则只写一遍。将来 Android / 鸿蒙 / iOS 都复用这份合并逻辑，
 *    不会出现"这个端的冲突处理和那个端不一样"这种经典灾难
 * 3. **可测**：全是纯函数，不需要起服务器就能把冲突场景测个遍
 *
 * ## 合并规则（业务逻辑文档 §8.3）
 *
 * - **后改的赢**：比 `updatedAt`
 * - **删除优先**：只要任一侧是删除态，结果就是删除态
 *
 * 两条规则看起来有冲突，实际是分层的：删除优先是**更高优先级**的裁决。
 * 理由：一条被删掉的待办"自己活过来"是最像 bug 的行为 ——
 * 用户会觉得"我明明删了它怎么又回来了"。而反过来（删除覆盖了一次改动）
 * 用户顶多重新建一条，不会有"这软件坏了"的感觉。
 * 代价是**故意且已知的**：删除之后再编辑，编辑会输。
 */

import type { Todo } from "@kuaiban/shared";

// ─────────────────────────────────────────────────────────────
// 协议（服务端与客户端共用）
// ─────────────────────────────────────────────────────────────

/**
 * 服务端存的一条记录。
 *
 * `payload` **对服务端是不透明的**：它可能是一段密文，也可能是明文 JSON，
 * 服务端不解析、不修改、不索引，只负责原样存下来再原样发回去。
 */
export interface SyncRecord {
  id: string;
  /** 内容载荷（见 TodoCodec） */
  payload: string;
  updatedAt: string;
  deletedAt: string | null;
  /**
   * 服务端分配的**单调递增**序号。
   *
   * 增量拉取用它而不是用时间：客户端时钟不可信（可能快几分钟、也可能慢几小时），
   * 用时间做游标会漏记录。序号由服务端一台机器统一分配，天然没有这个问题。
   */
  seq: number;
}

/** 客户端要推上去的一条 */
export interface SyncPushItem {
  id: string;
  payload: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SyncRequest {
  /** 上次拉到的服务端游标（0 = 全量拉一次） */
  cursor: number;
  /** 本地有变化的记录 */
  push: SyncPushItem[];
  /** 一次最多拉多少条（服务端会夹到上限） */
  limit?: number;
}

export interface SyncResponse {
  /** 服务端上自 `cursor` 以来变化过的记录 */
  pull: SyncRecord[];
  /** 新的游标 */
  cursor: number;
  /** 服务端是否还有更多没发完（客户端可立刻再拉一次） */
  hasMore: boolean;
  /** 被拒绝的记录（比如内容过大），客户端应提示用户而不是静默丢弃 */
  rejected: { id: string; reason: string }[];
}

// ─────────────────────────────────────────────────────────────
// 载荷编解码
// ─────────────────────────────────────────────────────────────

/**
 * 待办 ↔ 载荷字符串。
 *
 * 做成可替换的接口，是为了把"要不要端到端加密"这个决定**隔离在一个小口子上**：
 * 合并逻辑只认 `Todo`，完全不知道载荷是明文还是密文。
 * 将来接入加密时，只需要换一个 codec，同步逻辑一行不用动。
 */
export interface TodoCodec {
  encode(todo: Todo): string;
  decode(payload: string): Todo;
}

/** 明文编解码（本地开发、单机、以及加密尚未启用时用） */
export const plaintextCodec: TodoCodec = {
  encode(todo) {
    return JSON.stringify(todo);
  },
  decode(payload) {
    return JSON.parse(payload) as Todo;
  },
};

/** 把待办转成待推送的记录 */
export function toPushItem(todo: Todo, codec: TodoCodec = plaintextCodec): SyncPushItem {
  return {
    id: todo.id,
    payload: codec.encode(todo),
    updatedAt: todo.updatedAt,
    deletedAt: todo.deletedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// 合并
// ─────────────────────────────────────────────────────────────

/** 一条记录是不是"墓碑"（已删除） */
export function isTombstone(todo: Todo): boolean {
  return todo.deletedAt !== null;
}

/** 比较两个 ISO 时间戳，a 是否严格晚于 b。解析不出来时当相等处理（不冒险） */
function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

export interface SyncConflict {
  id: string;
  winner: "local" | "remote";
  /** 为什么这么裁决 —— 出问题时能解释清楚，而不是"它自己就变成这样了" */
  reason: "newer" | "deleted" | "tie";
}

export interface MergeOutcome {
  /** 合并后的**全集**（含墓碑）。本地应按这个落盘 */
  merged: Todo[];
  /**
   * 本地比远端新的、需要推上去的。
   *
   * ⚠️ **只有在 `remote` 是完整集合时才可直接使用**（比如首次全量同步）。
   * 增量同步时 `remote` 只是"自游标以来的变化"，直接用它会把所有本地记录都判成要推，
   * 进而导致两台设备互相覆盖、永不收敛 —— 增量场景请用 `planPush`。
   */
  toPush: Todo[];
  /** 裁决过冲突的记录（含原因） */
  conflicts: SyncConflict[];
}

/**
 * 合并本地与远端的待办集合。
 *
 * 纯函数：不改动入参、不碰存储、不认识网络。调用方拿 `merged` 落盘、
 * 拿 `toPush` 发请求。
 *
 * 规则见文件顶部。**幂等**：把结果再合并一次，结果不变（有测试守着）。
 */
export function mergeTodos(local: readonly Todo[], remote: readonly Todo[]): MergeOutcome {
  const remoteById = new Map(remote.map((t) => [t.id, t]));
  const localIds = new Set(local.map((t) => t.id));

  const merged: Todo[] = [];
  const toPush: Todo[] = [];
  const conflicts: SyncConflict[] = [];
  const seen = new Set<string>();

  for (const mine of local) {
    seen.add(mine.id);
    const theirs = remoteById.get(mine.id);

    // 远端没有 → 本地独有，保留并推上去
    if (!theirs) {
      merged.push(mine);
      toPush.push(mine);
      continue;
    }

    // ── 删除优先（最高优先级）──
    // 只要一侧是删除态，结果就是删除态。见文件顶部对代价的说明。
    if (isTombstone(mine) && isTombstone(theirs)) {
      merged.push(pickNewer(mine, theirs));
      continue;
    }
    if (isTombstone(mine)) {
      merged.push(mine); // 本地删的，赢；推上去让别的设备也删掉
      toPush.push(mine);
      if (!isTombstone(theirs)) conflicts.push({ id: mine.id, winner: "local", reason: "deleted" });
      continue;
    }
    if (isTombstone(theirs)) {
      merged.push(theirs); // 别的设备删的，本地跟着删
      conflicts.push({ id: mine.id, winner: "remote", reason: "deleted" });
      continue;
    }

    // ── 后改的赢 ──
    if (isNewer(mine.updatedAt, theirs.updatedAt)) {
      merged.push(mine);
      toPush.push(mine);
      conflicts.push({ id: mine.id, winner: "local", reason: "newer" });
      continue;
    }
    if (isNewer(theirs.updatedAt, mine.updatedAt)) {
      merged.push(theirs);
      conflicts.push({ id: mine.id, winner: "remote", reason: "newer" });
      continue;
    }

    // ── 时间戳一模一样 ──
    // 正常情况内容也相同（同一次修改同步出去的），取本地即可。
    // 记成 tie 是为了万一出了怪问题，日志里能看出来。
    merged.push(mine);
    if (!sameTodo(mine, theirs)) {
      conflicts.push({ id: mine.id, winner: "local", reason: "tie" });
    }
  }

  // 远端独有的（别的设备新建的）→ 直接收下，不需要回推
  for (const theirs of remote) {
    if (seen.has(theirs.id) || localIds.has(theirs.id)) continue;
    merged.push(theirs);
  }

  return { merged, toPush, conflicts };
}

/** 两个墓碑谁更"新"（两边都删了的情况，取时间靠后的，纯粹为了确定性） */
function pickNewer(a: Todo, b: Todo): Todo {
  return isNewer(b.updatedAt, a.updatedAt) ? b : a;
}

/** 忽略 updatedAt 的浅比较（用于判断"时间戳相同但内容不同"这种异常） */
function sameTodo(a: Todo, b: Todo): boolean {
  const { updatedAt: _a, ...restA } = a;
  const { updatedAt: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

// ─────────────────────────────────────────────────────────────
// 待上传队列
// ─────────────────────────────────────────────────────────────

/**
 * 待上传队列 —— 客户端必须自己记"哪些记录是我改过的"。
 *
 * ## 为什么必须有它（这是踩过的坑，不是假想）
 *
 * `mergeTodos` 返回的 `toPush` 是"本地比远端新的"。这个判断有个前提：
 * **远端集合必须是完整的**。可增量同步时，远端只是"自游标以来发生的变化"，
 * 拿它当全集算 toPush，会把**所有没改过的本地记录**也判成"要推"。
 *
 * 后果远不止"多推几条"：
 *
 * > 两台设备各自把自己那份推上去、覆盖服务端的记录，
 * > 然后各自从服务端拉回来的又正是自己刚推的那份 ——
 * > **两台设备永远收敛不到一起。**
 *
 * 这个失败模式在 server 的测试里真实复现过：A 改成「A 的版本」、
 * B 改成「B 的版本」，来回同步好几轮之后 A 手里仍是 A、B 手里仍是 B。
 *
 * 所以规则是：**本地每一次写入（新建 / 编辑 / 完成 / 删除）都 markDirty，
 * 只推 pending 里的**；推成功后 markPushed 清掉。
 */
export interface PushTracker {
  markDirty(id: string): void;
  markPushed(ids: readonly string[]): void;
  pending(): string[];
  count(): number;
  has(id: string): boolean;
  clear(): void;
}

export function createPushTracker(initial?: Iterable<string>): PushTracker {
  const dirty = new Set<string>(initial ?? []);
  return {
    markDirty(id) {
      dirty.add(id);
    },
    markPushed(ids) {
      for (const id of ids) dirty.delete(id);
    },
    pending() {
      return [...dirty];
    },
    count() {
      return dirty.size;
    },
    has(id) {
      return dirty.has(id);
    },
    clear() {
      dirty.clear();
    },
  };
}

/** 从本地集合里挑出"本地改过"的那些 */
export function pickToPush(local: readonly Todo[], tracker: PushTracker): Todo[] {
  return local.filter((t) => tracker.has(t.id));
}

/**
 * 算出一趟增量同步**真正该推**的记录。
 *
 * = **本地改过的**（tracker） ∪ **合并时本地赢了远端的**（conflicts）
 *
 * ## 为什么必须并上后者（第二个踩过的坑）
 *
 * 假设 A 和 B 同时改了同一条待办，A 改得更晚：
 *
 * 1. A 推上自己的版本，清空 dirty
 * 2. B 推上自己的版本，服务端记录变成 B 的
 * 3. A 同步时拉回 B 的版本，比较时间戳后**本地保留 A 的版本** —— 合并是对的
 * 4. 但 A 本地**并没有"改动"**（它的版本第 1 步就推过了），dirty 是空的
 *    → A 什么都不推
 * 5. B 下次同步拉不到任何新东西 → **B 永远停在 B 的版本**
 *
 * 也就是说："我在合并里赢了"这件事**本身**就是一条新信息，必须回写上去。
 * 漏掉它，两台设备就永远收敛不到一起（而且表面上一切正常，极难发现）。
 */
export function planPush(
  local: readonly Todo[],
  tracker: PushTracker,
  conflicts: readonly SyncConflict[],
): Todo[] {
  const ids = new Set<string>(tracker.pending());
  for (const conflict of conflicts) {
    if (conflict.winner === "local") ids.add(conflict.id);
  }
  return local.filter((t) => ids.has(t.id));
}

// ─────────────────────────────────────────────────────────────
// 增量拉取后的本地合并
// ─────────────────────────────────────────────────────────────

/**
 * 把服务端拉回来的一批记录解码成待办。
 *
 * **单条解码失败不能拖垮整次同步**：一条坏记录（比如旧版本写入的格式、
 * 或密钥换了导致解不开）不应该让用户所有的数据都同步不了。
 * 失败的记进 `broken`，由调用方决定是提示用户还是忽略。
 */
export function decodePull(
  records: readonly SyncRecord[],
  codec: TodoCodec = plaintextCodec,
): { todos: Todo[]; broken: { id: string; reason: string }[] } {
  const todos: Todo[] = [];
  const broken: { id: string; reason: string }[] = [];

  for (const record of records) {
    try {
      const todo = codec.decode(record.payload);
      // 服务端的元数据是权威的：id / 删除标记以服务端为准，
      // 免得客户端伪造出一个和 id 对不上的载荷
      todos.push({ ...todo, id: record.id, deletedAt: record.deletedAt });
    } catch (err) {
      broken.push({ id: record.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { todos, broken };
}

// ─────────────────────────────────────────────────────────────
// 同步循环（一次完整同步 = 若干轮"拉 → 合并 → 推"）
// ─────────────────────────────────────────────────────────────

/**
 * 传输层：把一次 `SyncRequest` 发出去、拿回 `SyncResponse`。
 *
 * 这是**唯一**需要各平台自己实现的部分（桌面端用 Tauri 的 HTTP、手机端用各自的，
 * 服务端测试里用一个直连 store 的假传输）。同步规则本身一行都不用重写。
 */
export interface SyncTransport {
  (request: SyncRequest): Promise<SyncResponse>;
}

export interface RunSyncOptions {
  /** 本地全部待办（含墓碑） */
  local: readonly Todo[];
  /** 本地改动标记（见 createPushTracker） */
  tracker: PushTracker;
  /** 上次拉到的游标 */
  cursor: number;
  transport: SyncTransport;
  codec?: TodoCodec;
  /** 最多来回几轮。默认 3 —— 正常一两轮就收敛，多几轮兜底 */
  maxRounds?: number;
}

export interface SyncRunResult {
  /** 合并后的本地集合，调用方应据此落盘 */
  local: Todo[];
  cursor: number;
  /** 实际跑了几轮 */
  rounds: number;
  /** 所有轮次的冲突裁决记录 */
  conflicts: SyncConflict[];
  /** 服务端拒收的（界面要提示用户，不能静默丢） */
  rejected: { id: string; reason: string }[];
  /** 解不开的记录（比如换了密钥），不应拖垮整次同步 */
  broken: { id: string; reason: string }[];
}

/**
 * 跑一次完整同步。
 *
 * ## 每一轮做什么
 *
 * 1. 挑出要推的：**本地改过的** ∪ **上一轮发现"本地赢了"的**
 * 2. 发一次请求（服务端**先拉后推**，理由见服务端 app.ts）
 * 3. 合并拉回来的记录
 * 4. 如果这一轮有"本地赢了"的冲突，或服务端还有更多没发完，就再来一轮
 *
 * ## 为什么要循环（而不是一次请求就完）
 *
 * 冲突是**拉回来之后**才知道的。发现"我这版更新"时，这一轮的请求已经发出去了，
 * 只能下一轮再把它回写上去。
 * 不循环的话，两台设备就会出现"A 明明赢了却没人告诉服务端"的死局
 * （这个坑在 server 的收敛测试里复现过）。
 */
export async function runSync(options: RunSyncOptions): Promise<SyncRunResult> {
  const codec = options.codec ?? plaintextCodec;
  const maxRounds = Math.max(1, options.maxRounds ?? 3);

  let local = [...options.local];
  let cursor = options.cursor;

  const conflicts: SyncConflict[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const broken: { id: string; reason: string }[] = [];
  /** 上一轮发现"本地赢了远端"的 id —— 必须回写 */
  let carry: string[] = [];
  /**
   * 本次同步里已经被拒过的 id。
   *
   * 本轮不再重试：拒收通常是**确定性**的（内容过大、id 非法），
   * 立刻原地重试三次只会把同一个错误刷三遍，什么问题也解决不了。
   * 标记留着，等下一次同步再试（那时用户可能已经把内容改小了）。
   */
  const rejectedIds = new Set<string>();
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;

    const tracker = createPushTracker([...options.tracker.pending(), ...carry]);
    const toPush = pickToPush(local, tracker).filter((todo) => !rejectedIds.has(todo.id));
    const push = toPush.map((todo) => toPushItem(todo, codec));

    const response = await options.transport({ cursor, push });
    cursor = response.cursor;
    rejected.push(...response.rejected);

    const decoded = decodePull(response.pull, codec);
    broken.push(...decoded.broken);

    const merged = mergeTodos(local, decoded.todos);
    local = merged.merged;
    conflicts.push(...merged.conflicts);

    // 推成功的才清标记。被拒的**留着**，下次再试 —— 静默丢掉等于用户白写。
    const refusedThisRound = new Set(response.rejected.map((r) => r.id));
    for (const id of refusedThisRound) rejectedIds.add(id);
    options.tracker.markPushed(
      toPush.filter((todo) => !refusedThisRound.has(todo.id)).map((todo) => todo.id),
    );

    carry = merged.conflicts.filter((c) => c.winner === "local").map((c) => c.id);

    if (push.length === 0 && carry.length === 0 && !response.hasMore) break;
  }

  return { local, cursor, rounds, conflicts, rejected, broken };
}
