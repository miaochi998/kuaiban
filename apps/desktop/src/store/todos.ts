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
  type TodoEdit,
  type RepeatRule,
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

/**
 * "数据存不下来"的警告。
 *
 * 独立于 fatalError：致命错误是"用不了"，这个警告是"能用但会丢"。
 * 后者更危险 —— 用户会以为已经存好了，所以必须一直显眼地摆在那里。
 */
const storageWarning = ref<string | null>(null);

/** 启动阶段的可读描述。卡住时能一眼看出停在哪一步（诊断用，也便于用户报障） */
const loadPhase = ref("启动中");

export function reportPhase(phase: string): void {
  loadPhase.value = phase;
}

/**
 * 最近一次写操作的失败原因。
 *
 * 存在的理由：写库失败如果没人接，就只是浏览器控制台里一条没人看的报错，
 * 界面上表现为"点了回车没有任何反应"。有了它，失败必须变成看得见的一句话。
 */
const lastError = ref<string | null>(null);

/** 一闪而过的成功提示（"已添加「写周报」"） */
const notice = ref<string | null>(null);

/** 刚添加的那条的 id —— 让它在清单里闪一下，眼睛才抓得住 */
const justAddedId = ref<string | null>(null);

/** 当前时刻。tick 它 = 驱动"业务日"翻天，是逾期顺延的唯一动力 */
const now = ref(new Date());

const activeTab = ref<PanelTab>("today");

const service = shallowRef<TodoService | null>(null);

/** 每 30 秒更新一次 now。跨过凌晨 4 点时清单会自动翻天 */
const CLOCK_TICK_MS = 30_000;
/** 成功提示停留多久 */
const NOTICE_MS = 2600;
/** 新条目高亮多久 */
const HIGHLIGHT_MS = 1400;

let clockTimer: ReturnType<typeof setInterval> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

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

/** 读取待办最多等多久。超过就报错，绝不让界面停在"正在读取…"转圈 */
const LOAD_TIMEOUT_MS = 10_000;

export async function initTodoStore(repo: TodoRepository) {
  service.value = new TodoService(repo);
  reportPhase("正在读取待办…");
  try {
    const loaded = await Promise.race([
      service.value.list(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`读取待办超时（超过 ${LOAD_TIMEOUT_MS / 1000} 秒没有响应）`)),
          LOAD_TIMEOUT_MS,
        ),
      ),
    ]);
    reportPhase(`E race 返回 ${loaded.length} 条`);
    todos.value = loaded;
    reportPhase("F 已写入内存副本");
  } catch (err) {
    fatalError.value = describe(err);
    console.error("[快办] 读取待办失败", err);
  } finally {
    // 无论成功失败都必须"就绪"：否则列表区会永远停在加载态，
    // 用户刚添加的东西也就永远显示不出来。
    ready.value = true;
    reportPhase(fatalError.value ? "读取失败" : "已就绪");
  }

  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      now.value = new Date();
    }, CLOCK_TICK_MS);
  }
}

/**
 * 启动流程整体失败时由 main.ts 调用。
 *
 * 存在的意义就是**让失败可见**：以前 main.ts 的 catch 只写 console.error，
 * 于是"数据库打不开"在界面上完全看不出来 —— 停在"正在读取…"，
 * 用户添加的东西写不进库（或写进去了但读不出来），且没有任何提示。
 */
export function reportFatal(message: string): void {
  fatalError.value = message;
  ready.value = true;
}

/**
 * 退化成内存存储时的警告。
 *
 * 必须显眼：这意味着**用户这次记的东西关掉软件就没了**。
 * 静默的临时存储比直接报错更危险 —— 用户会以为已经存好了。
 */
export function reportStorageWarning(message: string): void {
  storageWarning.value = message;
  console.warn(`[快办] ${message}`);
}

// ─────────────────────────────────────────────────────────────
// 动作（薄封装：调大脑 → 替换内存副本）
// ─────────────────────────────────────────────────────────────

function replace(next: Todo) {
  todos.value = todos.value.map((t) => (t.id === next.id ? next : t));
}

function requireService(): TodoService {
  const s = service.value;
  if (!s) throw new Error("待办服务尚未初始化");
  return s;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/**
 * 所有写操作的统一外壳。
 *
 * **为什么必须有这层**：写库失败（权限被拒、磁盘满、数据库锁住）如果没人接，
 * 就变成一个没人处理的 Promise 拒绝 —— 界面上的表现是"点了回车没有任何反应"。
 * 用户会以为记下了，其实什么都没发生。这是本产品最不可接受的失败模式，
 * 所以每一次写操作都必须能变成界面上看得见的一句话。
 */
async function write(what: string, op: () => Promise<void>): Promise<boolean> {
  try {
    await op();
    lastError.value = null;
    return true;
  } catch (err) {
    lastError.value = `${what}失败：${describe(err)}`;
    console.error(`[快办] ${lastError.value}`, err);
    return false;
  }
}

/** 一闪而过的成功提示（"已添加「写周报」"），让用户确信这一次操作生效了 */
export function flashNotice(text: string): void {
  notice.value = text;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
    noticeTimer = null;
  }, NOTICE_MS);
}

export interface AddOptions {
  title: string;
  date: DateKey | null;
  time?: TimeOfDay | null;
  /** 重复规则（由输入框里的「每周六」这类词解析出来） */
  repeat?: RepeatRule;
}

/** 新增。返回是否成功（失败原因在 `lastError` 里） */
export async function addTodo({
  title,
  date,
  time = null,
  repeat,
}: AddOptions): Promise<Todo | null> {
  let created: Todo | null = null;
  const ok = await write("添加待办", async () => {
    created = await requireService().add({
      title,
      date,
      time,
      ...(repeat ? { repeat } : {}),
    });
  });
  if (ok && created) {
    todos.value = [...todos.value, created];
    // 记下"刚加的是哪条"，让它在清单里闪一下 —— 只靠"多了一行"太容易被忽略
    justAddedId.value = (created as Todo).id;
    if (highlightTimer !== null) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      justAddedId.value = null;
      highlightTimer = null;
    }, HIGHLIGHT_MS);
  }
  // 返回**真正落盘的那条**（而不是 boolean）：起始日可能被重复规则对齐过
  // （「工作日 打卡」建在周六 → 推到周一），界面需要拿实际日期去告诉用户
  // "从哪天开始"，否则用户会以为自己选错了日期。
  return ok ? created : null;
}

/** 勾选 / 取消勾选当前这一天的这一次 */
export async function toggleDone(todo: Todo, dateKey: DateKey): Promise<boolean> {
  const done = isOccurrenceDone(todo, dateKey);
  return write(done ? "取消完成" : "标记完成", async () => {
    replace(await requireService().setDone(todo, dateKey, !done));
  });
}

/** 移到某一天（逾期区的一键"搬到今天"用的就是它） */
export async function moveTodoTo(todo: Todo, dateKey: DateKey | null): Promise<boolean> {
  return write("改期", async () => {
    replace(await requireService().moveTo(todo, dateKey));
  });
}

/**
 * 编辑：内容 / 日期 / 时间 / 重复规则。
 * 一次改完一次落盘 —— 界面上用户就是点一次"保存"，不该留下半截状态。
 */
export async function editTodo(todo: Todo, edit: TodoEdit): Promise<boolean> {
  return write("修改", async () => {
    replace(await requireService().applyEdit(todo, edit));
  });
}

/**
 * 把一次同步合并后的结果落盘。
 *
 * 只写**真正变化了的**记录：一次同步可能带回上千条，其中绝大多数本地已经有了，
 * 全量重写会让每次同步都变成一次大事务。判断依据是 updatedAt / deletedAt 变了没。
 */
export async function applySynced(merged: readonly Todo[]): Promise<boolean> {
  const before = new Map(todos.value.map((t) => [t.id, t]));
  const changed = merged.filter((todo) => {
    const previous = before.get(todo.id);
    return (
      !previous ||
      previous.updatedAt !== todo.updatedAt ||
      previous.deletedAt !== todo.deletedAt
    );
  });

  if (changed.length === 0) return true;

  return write("同步", async () => {
    await requireService().putMany(changed);
    todos.value = [...merged];
  });
}

/**
 * 清空**本机**全部待办。
 *
 * 只在一种情况下调用：这台电脑上的数据属于**别的账号**，而用户明确表示不要它们。
 * 名称里特意带 `Local`，因为这个动作**不通知服务端** ——
 * 它删的是本机这份数据，不是"把待办删掉"（那要走 removeTodo 的软删除）。
 */
export async function discardAllLocal(): Promise<boolean> {
  return write("清空", async () => {
    await requireService().clearAll();
    todos.value = [];
  });
}

/** 删除（软删除，数据还在库里，只是不再出现） */
export async function removeTodo(todo: Todo): Promise<boolean> {
  return write("删除", async () => {
    replace(await requireService().remove(todo));
  });
}

/** 批量把昨日未完成搬到今天 */
export async function carryOverAll(): Promise<boolean> {
  const targets = view.value.overdue.map((o) => o.todo);
  if (targets.length === 0) return true;

  return write("批量改期", async () => {
    const svc = requireService();
    const businessDate = view.value.businessDate;
    // 逐条改完再一次性合并进内存副本，避免中途失败时界面与库不一致
    const moved: Todo[] = [];
    for (const todo of targets) {
      moved.push(await svc.moveTo(todo, businessDate));
    }
    const byId = new Map(moved.map((t) => [t.id, t]));
    todos.value = todos.value.map((t) => byId.get(t.id) ?? t);
  });
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
    storageWarning,
    loadPhase,
    now,
    activeTab,
    lastError,
    notice,
    justAddedId,
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
    editTodo,
    applySynced,
    discardAllLocal,
    carryOverAll,
    flashNotice,
  };
}
