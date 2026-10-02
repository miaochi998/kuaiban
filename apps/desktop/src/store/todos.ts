/**
 * 待办状态层
 *
 * 职责很薄：**持有内存副本 + 调大脑 + 落盘**。
 * 所有业务规则都在 `@kuaiban/core` 里，这里一行判断逻辑都不该有。
 *
 * 一个关键设计：`view` 是**算出来的**，不是存起来的。
 * 配合每 30 秒 tick 一次的 `now`，跨过凌晨 04:00 时 `view` 会自动重算 ——
 * 逾期顺延就这样"自动发生"了，**不需要任何定时任务**。
 */

import { computed, ref, shallowRef } from "vue";
import {
  TodoService,
  buildDailyView,
  isOccurrenceDone,
  type DateKey,
  type Todo,
  type TodoRepository,
  type TimeOfDay,
} from "@kuaiban/core";

/** 面板的四个视角 */
export type PanelTab = "today" | "tomorrow" | "inbox" | "calendar";

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────

const todos = ref<Todo[]>([]);
const ready = ref(false);
const fatalError = ref<string | null>(null);

/** 当前时刻。tick 它 = 驱动"业务日"翻天，是逾期顺延的唯一动力 */
const now = ref(new Date());

const activeTab = ref<PanelTab>("today");

const service = shallowRef<TodoService | null>(null);

/** 每 30 秒更新一次 now。跨过凌晨 4 点时清单会自动翻天 */
const CLOCK_TICK_MS = 30_000;
let clockTimer: number | null = null;

// ─────────────────────────────────────────────────────────────
// 派生：四个视角
// ─────────────────────────────────────────────────────────────

const view = computed(() => buildDailyView(todos.value, { now: now.value }));

/** 挂件角标上的数字 */
const remainingCount = computed(() => view.value.remainingCount);

/** 当前页签对应的待办列表 */
const visibleTodos = computed<Todo[]>(() => {
  switch (activeTab.value) {
    case "today":
      return view.value.today;
    case "tomorrow":
      return view.value.tomorrow;
    case "inbox":
      return view.value.inbox;
    case "calendar":
      return [];
  }
});

/** 当前页签的"业务日"，勾选 / 跳过都要带上它（重复任务的完成是按天的） */
const visibleDateKey = computed<DateKey>(() =>
  activeTab.value === "tomorrow" ? view.value.tomorrowDate : view.value.businessDate,
);

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────

export async function initTodoStore(repo: TodoRepository) {
  service.value = new TodoService(repo);
  try {
    todos.value = await service.value.list();
  } catch (err) {
    fatalError.value = err instanceof Error ? err.message : String(err);
    console.error("[快办] 读取待办失败", err);
  } finally {
    ready.value = true;
  }

  if (clockTimer === null) {
    clockTimer = window.setInterval(() => {
      now.value = new Date();
    }, CLOCK_TICK_MS);
  }
}

// ─────────────────────────────────────────────────────────────
// 动作（薄封装：调大脑 → 替换内存副本）
// ─────────────────────────────────────────────────────────────

function replace(next: Todo) {
  todos.value = todos.value.map((t) => (t.id === next.id ? next : t));
}

function requireService(): TodoService {
  const s = service.value;
  if (!s) throw new Error("TodoService 尚未初始化");
  return s;
}

export interface AddOptions {
  title: string;
  date: DateKey | null;
  time?: TimeOfDay | null;
}

export async function addTodo({ title, date, time = null }: AddOptions): Promise<void> {
  const todo = await requireService().add({ title, date, time });
  todos.value = [...todos.value, todo];
}

/** 勾选 / 取消勾选当前这一天的这一次 */
export async function toggleDone(todo: Todo, dateKey: DateKey): Promise<void> {
  const done = isOccurrenceDone(todo, dateKey);
  replace(await requireService().setDone(todo, dateKey, !done));
}

/** 移到某一天（逾期区的一键"搬到今天"用的就是它） */
export async function moveTodoTo(todo: Todo, dateKey: DateKey | null): Promise<void> {
  replace(await requireService().moveTo(todo, dateKey));
}

/** 删除（软删除，数据还在库里，只是不再出现） */
export async function removeTodo(todo: Todo): Promise<void> {
  replace(await requireService().remove(todo));
}

/** 勾选"今天都没做完"的昨日事项：批量搬到今天 */
export async function carryOverAll(): Promise<void> {
  const targets = view.value.overdue.map((o) => o.todo);
  for (const todo of targets) {
    replace(await requireService().moveTo(todo, view.value.businessDate));
  }
}

// ─────────────────────────────────────────────────────────────
// 导出给界面用
// ─────────────────────────────────────────────────────────────

export function useTodoStore() {
  return {
    // 状态
    todos,
    ready,
    fatalError,
    now,
    activeTab,
    // 派生
    view,
    remainingCount,
    visibleTodos,
    visibleDateKey,
    // 动作
    addTodo,
    toggleDone,
    moveTodoTo,
    removeTodo,
    carryOverAll,
  };
}
