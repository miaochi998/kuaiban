/**
 * 应用服务 —— 把"领域规则"和"存储"接起来的那一层
 *
 * 定位：
 *   - 领域规则（core/date、repeat、todo、view、reminder）是**纯函数**，不认识存储
 *   - 存储端口（core/repository）只管读写
 *   - 本文件负责"改一个实体 → 立刻持久化 → 把新实体交给调用方"
 *
 * 它同样是**零平台依赖**的，因此可以用内存仓储在纯 Node 环境下完整测试。
 * 外壳（Vue 界面、将来的服务端）都只调这里的接口，不直接写 SQL。
 *
 * 刻意做成"无状态"：自己不持有列表，调用方拿到返回值后自行维护内存副本。
 * 这样和 Vue 的响应式数组配合最自然，也不会出现"两处各有一份真相"。
 */

import type { DateKey, NewTodoInput, RepeatRule, TimeOfDay, Todo } from "@kuaiban/shared";
import type { TodoRepository } from "./repository";
import { addDays } from "./date";
import { occursOn } from "./repeat";
import {
  completeOccurrence,
  createTodo,
  moveToDate,
  skipOccurrence,
  softDelete,
  uncompleteOccurrence,
  updateTodo,
} from "./todo";

export type Clock = () => Date;

export interface AddTodoOptions {
  /** 指定 id（测试用；生产默认走 crypto.randomUUID） */
  id?: string;
}

/**
 * 一次编辑里可以改哪些东西。
 *
 * 刻意做成"一个整体的修改请求"，而不是让界面分别调 moveTo / updateTodo：
 * 界面上用户是**一次点保存**，那就该是一次写入 —— 否则中途失败会留下
 * "日期改了、标题没改"这种半截状态。
 *
 * 字段为 `undefined` = 不改这一项；`date: null` = 退回随笔区。
 */
export interface TodoEdit {
  title?: string;
  date?: DateKey | null;
  time?: TimeOfDay | null;
  repeat?: RepeatRule;
  remindBefore?: number;
}

export class TodoService {
  constructor(
    private readonly repo: TodoRepository,
    /** 注入时钟，测试里可以固定时间 */
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** 读出全部待办（含软删除的；视图层用 isAlive 过滤） */
  list(): Promise<Todo[]> {
    return this.repo.list();
  }

  /** 新建一条并立即落盘 */
  async add(input: NewTodoInput, opts: AddTodoOptions = {}): Promise<Todo> {
    const todo = this.aligned(
      createTodo(input, { now: this.clock(), ...(opts.id ? { id: opts.id } : {}) }),
    );
    await this.repo.upsert([todo]);
    return todo;
  }

  /**
   * 勾选 / 取消勾选**某一天的这一次**。
   *
   * 注意参数里带 `dateKey` 而不是布尔字段：重复任务的"完成"是**按天**的，
   * 今天勾掉不代表明天也做完了（业务逻辑文档 §6.3）。
   */
  async setDone(todo: Todo, dateKey: DateKey, done: boolean): Promise<Todo> {
    const now = this.clock();
    const next = done
      ? completeOccurrence(todo, dateKey, now)
      : uncompleteOccurrence(todo, dateKey, now);
    await this.repo.upsert([next]);
    return next;
  }

  /** 跳过本次（"今天不做了，但系列继续"） */
  async skip(todo: Todo, dateKey: DateKey): Promise<Todo> {
    const next = skipOccurrence(todo, dateKey, this.clock());
    await this.repo.upsert([next]);
    return next;
  }

  /** 改期；传 null = 退回随笔区 */
  async moveTo(todo: Todo, dateKey: DateKey | null): Promise<Todo> {
    const next = moveToDate(todo, dateKey, this.clock());
    await this.repo.upsert([next]);
    return next;
  }

  /**
   * 起始日对齐到重复规则。
   *
   * 为什么必须做：一条「工作日」重复的待办如果起始日填的是**周六**，
   * 它永远不满足自己的规则 —— 建完就在清单里**消失**，用户会以为数据丢了。
   * （真实踩到过：用户在周六输入「工作日 打卡」，界面毫无反应。）
   *
   * 所以把起始日往后推到第一个真正满足规则的日子：起始日从此是**真的**，
   * 日历上也能在正确的日子看到它。
   */
  private aligned(todo: Todo): Todo {
    if (todo.date === null || todo.repeat.kind === "none") return todo;

    let day = todo.date;
    // 最多找 40 天：每月 31 号这种规则也可能要跨月才命中。
    // 找不到就原样返回 —— 宁可日期不理想，也不能在这里死循环。
    for (let i = 0; i < 40; i++) {
      if (occursOn(todo, day)) {
        return day === todo.date ? todo : { ...todo, date: day };
      }
      day = addDays(day, 1);
    }
    return todo;
  }

  /**
   * 编辑：内容 / 日期 / 时间 / 重复规则，一次改完并落盘。
   *
   * 两个细节值得说明：
   * - **只对传进来的字段动手**：`undefined` 表示"这一项别改"，
   *   所以不能直接把 edit 展开进对象（那会把没传的字段变成 undefined）。
   * - **给原本没时间的待办加时间时自动开提醒**：和新建时的默认一致
   *   （有时间 → 开提醒；没时间 → 关提醒，避免噪音）。
   *   只在"原来没有时间"时才自动开 —— 用户自己关掉的提醒不该被改个时间又打开。
   */
  async applyEdit(todo: Todo, edit: TodoEdit): Promise<Todo> {
    const now = this.clock();
    let next = todo;

    if (edit.date !== undefined) {
      next = moveToDate(next, edit.date, now);
    }

    next = updateTodo(
      next,
      {
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.time !== undefined ? { time: edit.time } : {}),
        ...(edit.repeat !== undefined ? { repeat: edit.repeat } : {}),
        ...(edit.remindBefore !== undefined ? { remindBefore: edit.remindBefore } : {}),
      },
      now,
    );

    if (edit.time !== undefined && edit.time !== null && todo.time === null) {
      next = { ...next, remind: true };
    }

    // 改了重复规则（或日期）之后同样要重新对齐，理由见 aligned()
    next = this.aligned(next);

    await this.repo.upsert([next]);
    return next;
  }

  /**
   * 删除。
   *
   * 走**软删除**（留 deletedAt），因为同步规则是"删除优先"：
   * 服务端要看到"这条被删了"这个事实，才能阻止它在别的设备上活过来。
   */
  async remove(todo: Todo): Promise<Todo> {
    const next = softDelete(todo, this.clock());
    await this.repo.upsert([next]);
    return next;
  }

  /** 批量落盘（导入、同步下来的变更等） */
  async put(todos: readonly Todo[]): Promise<void> {
    if (todos.length === 0) return;
    await this.repo.upsert(todos);
  }
}
