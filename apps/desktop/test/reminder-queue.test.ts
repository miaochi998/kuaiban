/**
 * 提醒队列纯逻辑测试
 *
 * 这里覆盖的是"提醒到底该不该出现"这类判断 —— 它们最容易写错，
 * 而且错了以后表现为"该响的不响 / 不该响的乱响"，在界面上很难复现。
 * 平台效果（声音、展开面板）不在这一层，由 store/reminders.ts 负责。
 */

import { describe, expect, it } from "vitest";
import { MISSED_AFTER_MS, type DueReminder } from "@kuaiban/core";
import { createTodo } from "@kuaiban/core";
import { activeReminders, escalating, newlyAppeared } from "../src/lib/reminder-queue";

const T0 = new Date("2026-06-15T09:30:00");
const T0_MS = T0.getTime();

function due(id: string, minutesAgo = 0): DueReminder {
  const todo = createTodo({ title: `事项${id}`, date: "2026-06-15", time: "09:30" }, { id });
  return {
    todo,
    occurrenceDate: "2026-06-15",
    fireAt: new Date(T0_MS - minutesAgo * 60_000),
    key: `${id}@2026-06-15`,
  };
}

const empty = { snoozed: new Map<string, number>(), muted: new Set<string>() };

describe("该不该展示", () => {
  it("到点的都展示", () => {
    const items = activeReminders({ due: [due("a"), due("b")], ...empty, nowMs: T0_MS });
    expect(items.map((i) => i.key)).toEqual(["a@2026-06-15", "b@2026-06-15"]);
  });

  it("今天静音的不展示（明天该响还是响）", () => {
    const items = activeReminders({
      due: [due("a"), due("b")],
      snoozed: new Map(),
      muted: new Set(["a@2026-06-15"]),
      nowMs: T0_MS,
    });
    expect(items.map((i) => i.key)).toEqual(["b@2026-06-15"]);
  });

  it("推后还没到期的不展示", () => {
    const items = activeReminders({
      due: [due("a")],
      snoozed: new Map([["a@2026-06-15", T0_MS + 60_000]]),
      muted: new Set(),
      nowMs: T0_MS,
    });
    expect(items).toHaveLength(0);
  });

  it("推后到期后重新出现", () => {
    const items = activeReminders({
      due: [due("a")],
      snoozed: new Map([["a@2026-06-15", T0_MS + 60_000]]),
      muted: new Set(),
      nowMs: T0_MS + 60_001,
    });
    expect(items).toHaveLength(1);
    // 计时起点变成"推后到期时刻"，所以不会一出现就被判成错过
    expect(items[0]!.effectiveAtMs).toBe(T0_MS + 60_000);
    expect(items[0]!.ageMs).toBe(1);
  });

  it("按实际计时起点排序：最该处理的排最前", () => {
    const items = activeReminders({
      due: [due("晚", 0), due("早", 20)],
      ...empty,
      nowMs: T0_MS,
    });
    // "早" 是 20 分钟前到点的，fireAt 更小 → 排前面
    expect(items.map((i) => i.todo.title)).toEqual(["事项早", "事项晚"]);
  });
});

describe("错过判定", () => {
  it("刚过点是正常提醒，不算错过", () => {
    const items = activeReminders({ due: [due("a", 1)], ...empty, nowMs: T0_MS });
    expect(items[0]!.missed).toBe(false);
  });

  it("过很久才算错过（软件没开着的时候）", () => {
    const late = T0_MS + MISSED_AFTER_MS + 60_000;
    const items = activeReminders({ due: [due("a", 0)], ...empty, nowMs: late });
    expect(items[0]!.missed).toBe(true);
  });

  it("推后过的不算错过（虽然原定时刻过去很久了）", () => {
    const late = T0_MS + MISSED_AFTER_MS + 60_000;
    const items = activeReminders({
      due: [due("a", 0)],
      snoozed: new Map([["a@2026-06-15", late]]), // 刚刚推后到期
      muted: new Set(),
      nowMs: late,
    });
    expect(items[0]!.missed).toBe(false);
  });
});

describe("新出现 vs 已存在（决定要不要响）", () => {
  it("上一轮没见过的才算新出现 —— 声音只响一次", () => {
    const items = activeReminders({ due: [due("a"), due("b")], ...empty, nowMs: T0_MS });
    expect(newlyAppeared(new Set(), items)).toHaveLength(2);
    // 下一轮：两条都见过了，不该再响
    expect(newlyAppeared(new Set(items.map((i) => i.key)), items)).toHaveLength(0);
  });

  it("刚出现的能被认出来", () => {
    const items = activeReminders({ due: [due("a"), due("b")], ...empty, nowMs: T0_MS });
    const fresh = newlyAppeared(new Set(["a@2026-06-15"]), items);
    expect(fresh.map((i) => i.key)).toEqual(["b@2026-06-15"]);
  });
});

describe("升级到气泡阶段", () => {
  const ESCALATE = 60_000;

  it("刚响的不升级（别打断用户手头的事）", () => {
    const items = activeReminders({ due: [due("a", 0)], ...empty, nowMs: T0_MS });
    expect(escalating(new Set(), items, ESCALATE)).toHaveLength(0);
  });

  it("过了一分钟还没处理才升级", () => {
    const items = activeReminders({ due: [due("a", 0)], ...empty, nowMs: T0_MS + 60_001 });
    expect(escalating(new Set(), items, ESCALATE)).toHaveLength(1);
  });

  it("升级过一次就不再重复弹（L3：只累积角标）", () => {
    const items = activeReminders({ due: [due("a", 0)], ...empty, nowMs: T0_MS + 600_000 });
    expect(escalating(new Set(["a@2026-06-15"]), items, ESCALATE)).toHaveLength(0);
  });

  it("多条同时到点会一起升级 —— 但它们只会显示在同一张卡片里", () => {
    const items = activeReminders({ due: [due("a", 0), due("b", 0)], ...empty, nowMs: T0_MS + 61_000 });
    expect(escalating(new Set(), items, ESCALATE)).toHaveLength(2);
  });
});
