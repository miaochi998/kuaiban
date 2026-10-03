import { describe, expect, it } from "vitest";
import {
  MemoryTodoRepository,
  TodoService,
  buildDailyView,
  dueReminders,
  occursOn,
  type Todo,
} from "../src";
import { MON } from "./helpers";

const NOW = new Date("2026-06-15T09:00:00"); // 周一

function make() {
  const repo = new MemoryTodoRepository();
  const service = new TodoService(repo, () => NOW);
  return { repo, service };
}

async function viewAt(service: TodoService, when: Date) {
  return buildDailyView(await service.list(), { now: when });
}

describe("TodoService —— 改实体 + 立刻落盘", () => {
  it("新建后立刻能在存储里读到", async () => {
    const { repo, service } = make();
    const t = await service.add({ title: "写周报", date: MON });
    expect((await repo.list()).map((x) => x.id)).toEqual([t.id]);
  });

  it("标题为空会报错，而且不会写库", async () => {
    const { repo, service } = make();
    await expect(service.add({ title: "   " })).rejects.toThrow();
    expect(await repo.list()).toHaveLength(0);
  });

  it("未排期的直接进随笔", async () => {
    const { service } = make();
    const t = await service.add({ title: "一个灵感" });
    const v = await viewAt(service, NOW);
    expect(v.inbox.map((x) => x.id)).toEqual([t.id]);
  });
});

describe("勾选 / 取消勾选", () => {
  it("一次性：勾选后进已完成区", async () => {
    const { service } = make();
    const t = await service.add({ title: "交周报", date: MON });
    const done = await service.setDone(t, MON, true);

    expect(done.status).toBe("done");
    const v = await viewAt(service, NOW);
    expect(v.today).toHaveLength(0);
    expect(v.doneToday.map((x) => x.id)).toEqual([t.id]);
  });

  it("一次性：取消勾选后回到今天", async () => {
    const { service } = make();
    const t = await service.add({ title: "交周报", date: MON });
    const done = await service.setDone(t, MON, true);
    const undone = await service.setDone(done, MON, false);

    expect(undone.status).toBe("pending");
    const v = await viewAt(service, NOW);
    expect(v.today.map((x) => x.id)).toEqual([t.id]);
  });

  it("重复任务：勾选只完成本次，明天还在", async () => {
    const { service } = make();
    const t = await service.add({ title: "吃药", date: "2026-06-01", repeat: { kind: "daily" } });

    await service.setDone(t, MON, true);

    const today = await viewAt(service, NOW);
    expect(today.today).toHaveLength(0);
    expect(today.doneToday.map((x) => x.id)).toEqual([t.id]);

    const tomorrow = await viewAt(service, new Date("2026-06-16T09:00:00"));
    expect(tomorrow.today.map((x) => x.id)).toEqual([t.id]); // 系列继续
  });

  it("勾选结果落盘了（重新读取仍是完成态）", async () => {
    const { repo, service } = make();
    const t = await service.add({ title: "x", date: MON });
    await service.setDone(t, MON, true);
    const reloaded = await repo.list();
    expect(reloaded[0]!.status).toBe("done");
  });
});

describe("逾期顺延的完整闭环", () => {
  it("搬到今天后不再逾期", async () => {
    const { service } = make();
    const t = await service.add({ title: "给客户回电话", date: "2026-06-10" });

    let v = await viewAt(service, NOW);
    expect(v.overdue.map((o) => [o.todo.id, o.overdueDays])).toEqual([[t.id, 5]]);

    await service.moveTo(t, MON);

    v = await viewAt(service, NOW);
    expect(v.overdue).toHaveLength(0);
    expect(v.today.map((x) => x.id)).toEqual([t.id]);
  });

  it("不搬也能干活：过夜后自动出现在「昨日未完成」", async () => {
    const { service } = make();
    const t = await service.add({ title: "报销单", date: MON });

    // 当天：在今天的清单里
    expect((await viewAt(service, NOW)).today.map((x) => x.id)).toEqual([t.id]);

    // 凌晨 3 点：业务日还是 06-15，不变
    expect((await viewAt(service, new Date("2026-06-16T03:00:00"))).overdue).toHaveLength(0);

    // 凌晨 4 点翻页：自动进入逾期，一条数据都没改
    const next = await viewAt(service, new Date("2026-06-16T04:00:00"));
    expect(next.overdue.map((o) => o.todo.id)).toEqual([t.id]);
    expect(next.today).toHaveLength(0);

    // 而且原始日期没被改写（"拖了多久"这个真相保住了）
    expect(next.overdue[0]!.todo.date).toBe(MON);
  });

  it("拖满 3 天会进入 needsAttention", async () => {
    const { service } = make();
    const t = await service.add({ title: "老账", date: "2026-06-10" });
    const v = await viewAt(service, NOW);
    expect(v.needsAttention.map((o) => o.todo.id)).toEqual([t.id]);
  });
});

describe("跳过本次 / 编辑 / 删除", () => {
  it("跳过本次：今天不出现，下周照旧", async () => {
    const { service } = make();
    const t = await service.add({
      title: "周会",
      date: MON,
      repeat: { kind: "weekly", weekdays: [1] },
    });

    await service.skip(t, MON);

    const today = await viewAt(service, NOW);
    expect(today.today).toHaveLength(0);

    const nextWeek = await viewAt(service, new Date("2026-06-22T09:00:00"));
    expect(nextWeek.today.map((x) => x.id)).toEqual([t.id]);
  });

  it("编辑内容与时间，落盘生效", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "开会", date: MON });
    await service.applyEdit(t, { title: "评审会", time: "14:00" });

    const saved = (await repo.list())[0]!;
    expect(saved.title).toBe("评审会");
    expect(saved.time).toBe("14:00");
  });

  it("给原本没时间的待办补上时间 → 自动开提醒（与新建时的默认一致）", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "买咖啡豆", date: MON }); // 没时间 → 默认不开提醒
    expect(t.remind).toBe(false);

    await service.applyEdit(t, { time: "09:30" });

    expect((await repo.list())[0]!.remind).toBe(true);
  });

  it("只改传进来的字段，没传的一律不动", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "开会", date: MON, time: "09:30", note: "带上合同" });
    await service.applyEdit(t, { title: "评审会" });

    const saved = (await repo.list())[0]!;
    expect(saved.title).toBe("评审会");
    expect(saved.time).toBe("09:30"); // 没传 time → 保持
    expect(saved.note).toBe("带上合同");
    expect(saved.date).toBe(MON);
  });

  it("一次改多个字段（界面上的『保存』就是一次写入）", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "开会", date: MON });

    await service.applyEdit(t, {
      title: "周会",
      date: "2026-06-20",
      time: "10:00",
      repeat: { kind: "weekly", weekdays: [6] },
    });

    const saved = (await repo.list())[0]!;
    expect(saved).toMatchObject({
      title: "周会",
      date: "2026-06-20",
      time: "10:00",
      repeat: { kind: "weekly", weekdays: [6] },
      remind: true,
    });
  });

  it("可以把日期改成 null，退回随笔区", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "灵感", date: MON });
    await service.applyEdit(t, { date: null });
    expect((await repo.list())[0]!.date).toBeNull();
  });

  it("可以把重复规则改掉，也可以改成不重复", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "周会", date: MON, repeat: { kind: "weekly", weekdays: [1] } });

    await service.applyEdit(t, { repeat: { kind: "daily" } });
    expect((await repo.list())[0]!.repeat).toEqual({ kind: "daily" });

    await service.applyEdit(t, { repeat: { kind: "none" } });
    expect((await repo.list())[0]!.repeat).toEqual({ kind: "none" });
  });

  it("删除是软删除：视图里消失，但库里留着给同步看", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "x", date: MON });

    const gone = await service.remove(t);

    expect(gone.deletedAt).not.toBeNull();
    expect(await repo.list()).toHaveLength(1); // ← 关键：不是真删
    expect((await viewAt(service, NOW)).today).toHaveLength(0);
  });
});

describe("与提醒引擎串联", () => {
  it("新建的定时待办能被提醒引擎捞出来", async () => {
    const { service } = make();
    await service.add({ title: "开会", date: MON, time: "09:30" });

    const due = dueReminders(await service.list(), new Date("2026-06-15T09:30:05"));
    expect(due.map((d) => d.todo.title)).toEqual(["开会"]);
  });

  it("勾选完成后不再提醒", async () => {
    const { service } = make();
    const t = await service.add({ title: "开会", date: MON, time: "09:30" });
    await service.setDone(t, MON, true);

    const due = dueReminders(await service.list(), new Date("2026-06-15T09:30:05"));
    expect(due).toHaveLength(0);
  });
});

describe("存储语义：存的是快照", () => {
  it("改动返回的对象不会污染存储", async () => {
    const { service, repo } = make();
    const t = await service.add({ title: "原始", date: MON });

    t.title = "偷偷改的";
    t.skippedDates.push("2026-01-01");

    const saved = (await repo.list())[0]!;
    expect(saved.title).toBe("原始");
    expect(saved.skippedDates).toEqual([]);
  });

  it("读出来的对象改它也不会污染存储", async () => {
    const { service, repo } = make();
    await service.add({ title: "原始", date: MON });

    const read = (await repo.list())[0] as Todo;
    read.title = "改读出来的";

    expect((await repo.list())[0]!.title).toBe("原始");
  });

  it("重复规则里的数组是深拷贝", async () => {
    const { service, repo } = make();
    const t = await service.add({
      title: "周会",
      date: MON,
      repeat: { kind: "weekly", weekdays: [1, 3] },
    });

    (t.repeat as { weekdays: number[] }).weekdays.push(5);

    const saved = (await repo.list())[0]!;
    expect(saved.repeat).toEqual({ kind: "weekly", weekdays: [1, 3] });
  });
});

describe("put 批量落盘", () => {
  it("批量写入多条", async () => {
    const { service, repo } = make();
    const a = await service.add({ title: "a", date: MON });
    const b = await service.add({ title: "b", date: MON });

    await service.put([{ ...a, title: "a 改过" }, b]);

    const titles = (await repo.list()).map((x) => x.title).sort();
    expect(titles).toEqual(["a 改过", "b"]);
  });

  it("空数组是空操作", async () => {
    const { service, repo } = make();
    await service.put([]);
    expect(await repo.list()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 起始日对齐重复规则
//
// 踩到的真实 bug：用户在**周六**输入「工作日 打卡」，建完这条待办就在清单里
// 消失了 —— 因为「工作日」只匹配周一到周五，而它的起始日填的是周六，
// 永远不满足自己的规则。用户会以为数据丢了。
// ─────────────────────────────────────────────────────────────

describe("起始日对齐重复规则", () => {
  // 2026-10-03 是周六
  const SAT = "2026-10-03";

  it("「工作日」建在周六 → 起始日推到下一个工作日（周一）", async () => {
    const { service } = make();
    const t = await service.add({ title: "打卡", date: SAT, repeat: { kind: "weekdays" } });

    expect(t.date).toBe("2026-10-05"); // 周一
    expect(occursOn(t, "2026-10-05")).toBe(true);
    expect(occursOn(t, SAT)).toBe(false);
  });

  it("起始日本来就满足规则 → 不动它", async () => {
    const { service } = make();
    // 周六 + 每周六 → 当天就满足
    const t = await service.add({
      title: "周会",
      date: SAT,
      repeat: { kind: "weekly", weekdays: [6] },
    });
    expect(t.date).toBe(SAT);
  });

  it("「每月15号」建在 3 号 → 起始日推到 15 号", async () => {
    const { service } = make();
    const t = await service.add({
      title: "交材料",
      date: "2026-10-03",
      repeat: { kind: "monthly", days: [15] },
    });
    expect(t.date).toBe("2026-10-15");
  });

  it("不重复的待办不动它的日期", async () => {
    const { service } = make();
    const t = await service.add({ title: "买咖啡豆", date: SAT });
    expect(t.date).toBe(SAT);
  });

  it("随笔（无日期）不参与对齐", async () => {
    const { service } = make();
    const t = await service.add({ title: "灵感", date: null, repeat: { kind: "weekdays" } });
    expect(t.date).toBeNull();
  });

  it("建出来的待办在它的起始日一定能看到（这是这条规则存在的意义）", async () => {
    const { service } = make();
    const t = await service.add({ title: "打卡", date: SAT, repeat: { kind: "weekdays" } });
    // 起始日必须是真正会发生的那天，否则日历和对齐后的日期就对不上了
    expect(occursOn(t, t.date as string)).toBe(true);
  });

  it("编辑时把日期改到不匹配的一天，也会重新对齐", async () => {
    const { service } = make();
    const t = await service.add({ title: "打卡", date: "2026-10-05", repeat: { kind: "weekdays" } });
    expect(t.date).toBe("2026-10-05");

    // 改到周六 → 应该被推回下一个工作日
    const edited = await service.applyEdit(t, { date: SAT });
    expect(edited.date).toBe("2026-10-05");
  });

  it("编辑时把规则改成不匹配当前日期的，同样对齐", async () => {
    const { service } = make();
    const t = await service.add({ title: "打卡", date: SAT });
    const edited = await service.applyEdit(t, { repeat: { kind: "weekdays" } });
    expect(edited.date).toBe("2026-10-05");
  });
});
