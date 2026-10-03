import { describe, expect, it } from "vitest";
import {
  MemoryTodoRepository,
  TodoService,
  buildDailyView,
  dueReminders,
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
    await service.edit(t, { title: "评审会", time: "14:00" });

    const saved = (await repo.list())[0]!;
    expect(saved.title).toBe("评审会");
    expect(saved.time).toBe("14:00");
    expect(saved.remind).toBe(false); // 改时间不会自动开提醒，由界面显式决定
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
