/**
 * 同步合并规则测试
 *
 * 这一层的每个分支错一次，用户就可能**丢数据**或看到"我删了它又回来"。
 * 所以这里把每条规则、每个边界、以及"幂等"这种不变量都钉死。
 */

import { describe, expect, it } from "vitest";
import {
  createPushTracker,
  decodePull,
  mergeTodos,
  pickToPush,
  planPush,
  plaintextCodec,
  runSync,
  toPushItem,
  type SyncRecord,
  type SyncTransport,
} from "../src/sync";
import type { Todo } from "@kuaiban/shared";

/** 造一条待办；只关心合并需要的字段，其余给个合理默认 */
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

const T1 = "2026-10-03T10:00:00.000Z";
const T2 = "2026-10-03T11:00:00.000Z";
const T3 = "2026-10-03T12:00:00.000Z";

describe("只有一侧存在的记录", () => {
  it("本地独有 → 保留，并且要推上去", () => {
    const mine = todo({ id: "a", updatedAt: T1 });
    const { merged, toPush } = mergeTodos([mine], []);

    expect(merged.map((t) => t.id)).toEqual(["a"]);
    expect(toPush.map((t) => t.id)).toEqual(["a"]);
  });

  it("远端独有 → 收下，但不需要回推（避免无意义的写入）", () => {
    const theirs = todo({ id: "b", updatedAt: T1 });
    const { merged, toPush } = mergeTodos([], [theirs]);

    expect(merged.map((t) => t.id)).toEqual(["b"]);
    expect(toPush).toHaveLength(0);
  });

  it("两边都有互不相干的 → 合并成全集", () => {
    const { merged } = mergeTodos(
      [todo({ id: "a", updatedAt: T1 })],
      [todo({ id: "b", updatedAt: T1 })],
    );
    expect(merged.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

describe("后改的赢", () => {
  it("远端更新 → 远端的内容生效，本地不用推", () => {
    const mine = todo({ id: "a", updatedAt: T1, title: "旧标题" });
    const theirs = todo({ id: "a", updatedAt: T2, title: "新标题" });

    const { merged, toPush, conflicts } = mergeTodos([mine], [theirs]);

    expect(merged[0]!.title).toBe("新标题");
    expect(toPush).toHaveLength(0);
    expect(conflicts).toEqual([{ id: "a", winner: "remote", reason: "newer" }]);
  });

  it("本地更新 → 本地保留，并且推上去", () => {
    const mine = todo({ id: "a", updatedAt: T2, title: "本地较新" });
    const theirs = todo({ id: "a", updatedAt: T1, title: "远端较旧" });

    const { merged, toPush } = mergeTodos([mine], [theirs]);

    expect(merged[0]!.title).toBe("本地较新");
    expect(toPush.map((t) => t.id)).toEqual(["a"]);
  });

  it("时间戳一模一样且内容相同 → 不算冲突（正常情况）", () => {
    const same = todo({ id: "a", updatedAt: T1 });
    const { conflicts } = mergeTodos([same], [{ ...same }]);
    expect(conflicts).toEqual([]);
  });

  it("时间戳一模一样但内容不同 → 取本地，并记成 tie 以便排查", () => {
    const mine = todo({ id: "a", updatedAt: T1, title: "本地" });
    const theirs = todo({ id: "a", updatedAt: T1, title: "远端" });

    const { merged, conflicts } = mergeTodos([mine], [theirs]);

    expect(merged[0]!.title).toBe("本地");
    expect(conflicts).toEqual([{ id: "a", winner: "local", reason: "tie" }]);
  });

  it("时间戳解析不出来时不冒险（当相等处理，不崩）", () => {
    const mine = todo({ id: "a", updatedAt: "不是时间", title: "本地" });
    const theirs = todo({ id: "a", updatedAt: "也不是", title: "远端" });

    expect(() => mergeTodos([mine], [theirs])).not.toThrow();
    expect(mergeTodos([mine], [theirs]).merged[0]!.title).toBe("本地");
  });
});

describe("删除优先（比时间戳优先级更高）", () => {
  it("本地删了、远端没删 → 删除生效，并推上去让别的设备也删", () => {
    const mine = todo({ id: "a", updatedAt: T2, deletedAt: T2 });
    const theirs = todo({ id: "a", updatedAt: T1 });

    const { merged, toPush, conflicts } = mergeTodos([mine], [theirs]);

    expect(merged[0]!.deletedAt).toBe(T2);
    expect(toPush.map((t) => t.id)).toEqual(["a"]);
    expect(conflicts[0]).toMatchObject({ winner: "local", reason: "deleted" });
  });

  it("远端删了、本地没删 → 本地跟着删（哪怕本地改得更晚）", () => {
    // 这是「删除优先」的代价，刻意为之：让删掉的东西复活最像 bug
    const mine = todo({ id: "a", updatedAt: T3, title: "删掉之后又改了" });
    const theirs = todo({ id: "a", updatedAt: T2, deletedAt: T2 });

    const { merged, toPush, conflicts } = mergeTodos([mine], [theirs]);

    expect(merged[0]!.deletedAt).toBe(T2);
    expect(toPush).toHaveLength(0);
    expect(conflicts).toEqual([{ id: "a", winner: "remote", reason: "deleted" }]);
  });

  it("两边都删了 → 取时间靠后的那个墓碑（确定性）", () => {
    const mine = todo({ id: "a", updatedAt: T1, deletedAt: T1 });
    const theirs = todo({ id: "a", updatedAt: T2, deletedAt: T2 });

    expect(mergeTodos([mine], [theirs]).merged[0]!.deletedAt).toBe(T2);
  });
});

describe("不变量", () => {
  it("幂等：合并结果再合一次，结果不变（同步反复跑不能越跑越乱）", () => {
    const local = [
      todo({ id: "a", updatedAt: T1 }),
      todo({ id: "b", updatedAt: T3, title: "本地新" }),
      todo({ id: "c", updatedAt: T2, deletedAt: T2 }),
    ];
    const remote = [
      todo({ id: "b", updatedAt: T1, title: "远端旧" }),
      todo({ id: "c", updatedAt: T1 }),
      todo({ id: "d", updatedAt: T1 }),
    ];

    const once = mergeTodos(local, remote);
    const twice = mergeTodos(once.merged, remote);

    expect(twice.merged.map((t) => `${t.id}:${t.updatedAt}:${t.deletedAt}`).sort()).toEqual(
      once.merged.map((t) => `${t.id}:${t.updatedAt}:${t.deletedAt}`).sort(),
    );
  });

  it("远端全部已在本地 → 什么都不用推", () => {
    const local = [todo({ id: "a", updatedAt: T2 })];
    const remote = [todo({ id: "a", updatedAt: T1 })];
    // 本地更新，所以要推 —— 反过来才不用推
    expect(mergeTodos(local, remote).toPush).toHaveLength(1);
    expect(mergeTodos(remote, local).toPush).toHaveLength(0);
  });

  it("不改动入参（调用方还要拿它们做别的事）", () => {
    const local = [todo({ id: "a", updatedAt: T1 })];
    const remote = [todo({ id: "a", updatedAt: T2 })];
    const snapshot = JSON.stringify([local, remote]);

    mergeTodos(local, remote);

    expect(JSON.stringify([local, remote])).toBe(snapshot);
  });

  it("空集合不会出事", () => {
    expect(mergeTodos([], []).merged).toEqual([]);
  });
});

describe("载荷编解码", () => {
  it("明文 codec 往返一致", () => {
    const t = todo({ id: "a", updatedAt: T1, title: "交周报", note: "带合同" });
    expect(plaintextCodec.decode(plaintextCodec.encode(t))).toEqual(t);
  });

  it("转成待推送记录时带上时间与删除标记", () => {
    const t = todo({ id: "a", updatedAt: T1, deletedAt: T2 });
    expect(toPushItem(t)).toMatchObject({ id: "a", updatedAt: T1, deletedAt: T2 });
  });

  it("拉回来的记录以服务端元数据为准（id / 删除标记）", () => {
    // 载荷里写的是别的 id、且没删 —— 服务端说是什么就是什么
    const lying = todo({ id: "假的", updatedAt: T1 });
    const records: SyncRecord[] = [
      { id: "真的", payload: plaintextCodec.encode(lying), updatedAt: T1, deletedAt: T2, seq: 1 },
    ];

    const { todos } = decodePull(records);

    expect(todos[0]!.id).toBe("真的");
    expect(todos[0]!.deletedAt).toBe(T2);
  });

  it("一条坏记录不会拖垮整次同步（其余照常解出来）", () => {
    const good = todo({ id: "好", updatedAt: T1 });
    const records: SyncRecord[] = [
      { id: "坏", payload: "{这不是合法 JSON", updatedAt: T1, deletedAt: null, seq: 1 },
      { id: "好", payload: plaintextCodec.encode(good), updatedAt: T1, deletedAt: null, seq: 2 },
    ];

    const { todos, broken } = decodePull(records);

    expect(todos.map((t) => t.id)).toEqual(["好"]);
    expect(broken.map((b) => b.id)).toEqual(["坏"]);
    expect(broken[0]!.reason.length).toBeGreaterThan(0);
  });

  it("codec 可替换 —— 这是将来接端到端加密的口子", () => {
    const rot13: typeof plaintextCodec = {
      encode: (t) => JSON.stringify(t).replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)),
      decode: (p) => JSON.parse(p.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97))) as Todo,
    };
    const t = todo({ id: "a", updatedAt: T1, title: "secret" });

    const payload = toPushItem(t, rot13).payload;
    expect(payload).not.toContain("secret"); // 载荷里看不到原文
    expect(rot13.decode(payload)).toEqual(t); // 但能解回来
  });
});

// ─────────────────────────────────────────────────────────────
// 待上传队列
//
// 存在的理由是一个真实踩过的坑：增量同步下远端不是全集，
// 用它算"该推哪些"会把所有本地记录都推上去，
// 结果两台设备互相覆盖、**永远收敛不到一起**。
// ─────────────────────────────────────────────────────────────

describe("待上传队列", () => {
  it("只有标记过的才算待上传", () => {
    const tracker = createPushTracker();
    tracker.markDirty("a");

    expect(tracker.pending()).toEqual(["a"]);
    expect(tracker.count()).toBe(1);
    expect(tracker.has("a")).toBe(true);
    expect(tracker.has("b")).toBe(false);
  });

  it("推成功后清掉，不会重复推", () => {
    const tracker = createPushTracker(["a", "b"]);
    tracker.markPushed(["a"]);

    expect(tracker.pending()).toEqual(["b"]);
  });

  it("推过之后又改，会重新变成待上传", () => {
    const tracker = createPushTracker();
    tracker.markDirty("a");
    tracker.markPushed(["a"]);
    expect(tracker.count()).toBe(0);

    tracker.markDirty("a");
    expect(tracker.pending()).toEqual(["a"]);
  });

  it("重复标记同一个 id 不会重复出现", () => {
    const tracker = createPushTracker();
    tracker.markDirty("a");
    tracker.markDirty("a");
    expect(tracker.pending()).toEqual(["a"]);
  });

  it("pickToPush 只挑出待上传的那些记录", () => {
    const local = [
      todo({ id: "a", updatedAt: T1 }),
      todo({ id: "b", updatedAt: T1 }),
      todo({ id: "c", updatedAt: T1 }),
    ];
    const tracker = createPushTracker(["b"]);

    expect(pickToPush(local, tracker).map((t) => t.id)).toEqual(["b"]);
  });

  it("反例：拿 mergeTodos(local, []) 当待上传清单，会把全部本地记录都推上去", () => {
    // 这就是那个坑的具体形态 —— 远端为空时它把所有东西都判成"要推"。
    // 记成测试是为了让后来人一眼看到"为什么不能这么用"。
    const local = [todo({ id: "a", updatedAt: T1 }), todo({ id: "b", updatedAt: T1 })];

    expect(mergeTodos(local, []).toPush).toHaveLength(2); // 全推了 —— 错
    // 正确做法：只看自己改过的
    expect(pickToPush(local, createPushTracker(["a"])).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("planPush：增量同步真正该推什么", () => {
  it("本地改过的要推", () => {
    const local = [todo({ id: "a", updatedAt: T1 }), todo({ id: "b", updatedAt: T1 })];
    const tracker = createPushTracker(["a"]);

    expect(planPush(local, tracker, []).map((t) => t.id)).toEqual(["a"]);
  });

  it("合并时赢了远端的也要推 —— 哪怕本地没改过", () => {
    // 这就是第二个坑：A 的版本比 B 新，A 合并后保留自己的，
    // 但 A 本地"没改过"（早推过了）。不回写，B 就永远停在 B 的版本。
    const mine = todo({ id: "a", updatedAt: T3, title: "A 的版本" });
    const theirs = todo({ id: "a", updatedAt: T2, title: "B 的版本" });

    const outcome = mergeTodos([mine], [theirs]);
    expect(outcome.conflicts).toEqual([{ id: "a", winner: "local", reason: "newer" }]);

    // tracker 是空的（本地没改过），但依然要推
    const toPush = planPush([mine], createPushTracker(), outcome.conflicts);
    expect(toPush.map((t) => t.id)).toEqual(["a"]);
  });

  it("远端赢的不要推（推了等于把对方的改动打回去）", () => {
    const mine = todo({ id: "a", updatedAt: T1, title: "本地旧" });
    const theirs = todo({ id: "a", updatedAt: T2, title: "远端新" });

    const outcome = mergeTodos([mine], [theirs]);
    expect(planPush([theirs], createPushTracker(), outcome.conflicts)).toHaveLength(0);
  });

  it("远端根本没有这条、但本地也没改过 → 不推（远端集合可能只是增量的一段）", () => {
    // 这正是"拿 mergeTodos(local, partialRemote) 当待上传清单"会踩的坑
    const local = [todo({ id: "早就同步过的", updatedAt: T1 })];
    expect(planPush(local, createPushTracker(), [])).toHaveLength(0);
  });

  it("两边都推同一批不会重复", () => {
    const local = [todo({ id: "a", updatedAt: T3 })];
    const outcome = mergeTodos([local[0]!], [todo({ id: "a", updatedAt: T1 })]);

    const toPush = planPush(local, createPushTracker(["a"]), outcome.conflicts);
    expect(toPush.map((t) => t.id)).toEqual(["a"]);
  });
});

// ─────────────────────────────────────────────────────────────
// 同步循环（runSync）
//
// 用一个内存里的假服务端跑完整流程：收敛性、循环次数、被拒记录不能丢。
// 真实服务端另有端到端测试（apps/server/test）。
// ─────────────────────────────────────────────────────────────

/** 一个行为与真实服务端一致的内存仓库：先拉后推、每条写入分配新 seq */
function fakeServer() {
  const rows = new Map<string, SyncRecord>();
  let seq = 0;
  let pushCount = 0;

  const transport: SyncTransport = async (request) => {
    const pull = [...rows.values()]
      .filter((r) => r.seq > request.cursor)
      .sort((a, b) => a.seq - b.seq);

    const cursor = pull.length > 0 ? pull[pull.length - 1]!.seq : request.cursor;

    // 先拉后推 —— 顺序与服务端一致（见 apps/server/src/app.ts 的说明）
    pushCount += request.push.length;
    for (const item of request.push) {
      seq += 1;
      rows.set(item.id, { ...item, seq });
    }

    return { pull, cursor, hasMore: false, rejected: [] };
  };

  return { transport, rows, pushes: () => pushCount };
}

/** 一台设备 */
function device(transport: SyncTransport) {
  return {
    local: [] as Todo[],
    cursor: 0,
    tracker: createPushTracker(),
    async sync(maxRounds?: number) {
      const result = await runSync({
        local: this.local,
        tracker: this.tracker,
        cursor: this.cursor,
        transport,
        ...(maxRounds === undefined ? {} : { maxRounds }),
      });
      this.local = result.local;
      this.cursor = result.cursor;
      return result;
    },
    write(todo: Todo) {
      const at = this.local.findIndex((t) => t.id === todo.id);
      if (at >= 0) this.local[at] = todo;
      else this.local.push(todo);
      this.tracker.markDirty(todo.id);
    },
  };
}

describe("runSync 同步循环", () => {
  it("一台设备推上去，另一台拉下来", async () => {
    const server = fakeServer();
    const a = device(server.transport);
    const b = device(server.transport);

    a.write(todo({ id: "t1", updatedAt: T1, title: "交周报" }));
    await a.sync();

    await b.sync();
    expect(b.local.map((t) => t.title)).toEqual(["交周报"]);
  });

  it("推成功后标记被清掉，不会每轮重复推", async () => {
    const server = fakeServer();
    const a = device(server.transport);

    a.write(todo({ id: "t1", updatedAt: T1 }));
    await a.sync();
    expect(a.tracker.count()).toBe(0);

    await a.sync();
    await a.sync();
    expect(server.pushes()).toBe(1); // 只推过一次
  });

  it("两台设备冲突后收敛到「后改的赢」", async () => {
    const server = fakeServer();
    const a = device(server.transport);
    const b = device(server.transport);

    const base = todo({ id: "t1", updatedAt: T1, title: "初版" });
    a.write(base);
    await a.sync();
    b.write(base);
    await b.sync();

    a.write({ ...base, title: "A 的版本", updatedAt: T3 });
    b.write({ ...base, title: "B 的版本", updatedAt: T2 });

    // 各同步一次 —— runSync 内部会自己多跑几轮
    await a.sync();
    await b.sync();

    expect(a.local[0]!.title).toBe("A 的版本");
    expect(b.local[0]!.title).toBe("A 的版本");
  });

  it("收敛不靠运气：来回同步多轮结果不再变化", async () => {
    const server = fakeServer();
    const a = device(server.transport);
    const b = device(server.transport);

    const base = todo({ id: "t1", updatedAt: T1, title: "初版" });
    a.write(base);
    await a.sync();
    b.write(base);
    await b.sync();

    a.write({ ...base, title: "A", updatedAt: T3 });
    b.write({ ...base, title: "B", updatedAt: T2 });

    for (let i = 0; i < 8; i++) {
      await a.sync();
      await b.sync();
      expect(a.local[0]!.title).toBe(b.local[0]!.title);
    }
    expect(a.local[0]!.title).toBe("A");
  });

  it("A 删掉的，B 也会跟着删掉", async () => {
    const server = fakeServer();
    const a = device(server.transport);
    const b = device(server.transport);

    const base = todo({ id: "t1", updatedAt: T1 });
    a.write(base);
    await a.sync();
    b.write(base);
    await b.sync();

    a.write({ ...base, deletedAt: T2, updatedAt: T2 });
    await a.sync();
    await b.sync();

    expect(b.local[0]!.deletedAt).toBe(T2);
  });

  it("被服务端拒收的记录会把标记留着，下次继续试（不能静默丢）", async () => {
    const rows = new Map<string, SyncRecord>();
    let seq = 0;
    const transport: SyncTransport = async (request) => {
      const pull = [...rows.values()].filter((r) => r.seq > request.cursor);
      const cursor = pull.length > 0 ? pull[pull.length - 1]!.seq : request.cursor;
      const rejected = request.push.map((p) => ({ id: p.id, reason: "太大了" }));
      // 故意一条都不收
      return { pull, cursor, hasMore: false, rejected };
    };
    void seq;

    const a = device(transport);
    a.write(todo({ id: "t1", updatedAt: T1 }));

    const result = await a.sync();

    expect(result.rejected).toHaveLength(1);
    expect(a.tracker.has("t1")).toBe(true); // 标记还在 → 下次还会试
  });

  it("解不开的记录不会拖垮整次同步", async () => {
    const transport: SyncTransport = async () => ({
      pull: [
        { id: "坏的", payload: "不是 JSON", updatedAt: T1, deletedAt: null, seq: 1 },
        { id: "好的", payload: plaintextCodec.encode(todo({ id: "好的", updatedAt: T1 })), updatedAt: T1, deletedAt: null, seq: 2 },
      ],
      cursor: 2,
      hasMore: false,
      rejected: [],
    });

    const a = device(transport);
    const result = await a.sync();

    expect(result.broken.map((b) => b.id)).toEqual(["坏的"]);
    expect(a.local.map((t) => t.id)).toEqual(["好的"]);
  });

  it("游标会被带回来，下一轮不会重复拉同样的记录", async () => {
    const server = fakeServer();
    const a = device(server.transport);
    a.write(todo({ id: "t1", updatedAt: T1 }));
    await a.sync();
    const cursor = a.cursor;

    await a.sync();
    expect(a.cursor).toBe(cursor); // 没有新东西，游标不动
  });
});

describe("坏载荷不能拖垮整次同步", () => {
  const good = {
    id: "ok-1",
    title: "正经待办",
    date: null,
    time: null,
    status: "pending",
    repeat: null,
    lastDoneDate: null,
    skippedDates: [],
    remind: false,
    remindBefore: 0,
    note: "",
    completedAt: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    deletedAt: null,
  };

  it("字段不全的记录被隔离，好的照常同步", () => {
    const result = decodePull([
      { id: "ok-1", payload: JSON.stringify(good), updatedAt: good.updatedAt, deletedAt: null, seq: 1 },
      // 这就是真机上出问题的那种：能解析、但缺 status —— 落库会撞非空约束
      { id: "bad-1", payload: JSON.stringify({ title: "缺字段" }), updatedAt: "x", deletedAt: null, seq: 2 },
    ]);

    expect(result.todos.map((t) => t.id)).toEqual(["ok-1"]);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.id).toBe("bad-1");
    expect(result.broken[0]!.reason).toContain("status");
  });

  it("老版本载荷缺可选字段时给默认值，不整条丢弃", () => {
    const legacy = { id: "old-1", title: "老数据", status: "pending", repeat: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

    const result = decodePull([
      { id: "old-1", payload: JSON.stringify(legacy), updatedAt: legacy.updatedAt, deletedAt: null, seq: 1 },
    ]);

    expect(result.todos).toHaveLength(1);
    expect(result.todos[0]!.skippedDates).toEqual([]);
    expect(result.todos[0]!.remind).toBe(false);
    expect(result.todos[0]!.note).toBe("");
    expect(result.broken).toHaveLength(0);
  });

  it("完全不是对象的载荷也拦得住", () => {
    const result = decodePull([
      { id: "bad-2", payload: JSON.stringify([1, 2, 3]), updatedAt: "x", deletedAt: null, seq: 1 },
      { id: "bad-3", payload: "null", updatedAt: "x", deletedAt: null, seq: 2 },
    ]);
    expect(result.todos).toHaveLength(0);
    expect(result.broken).toHaveLength(2);
  });
});
