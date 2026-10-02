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

import type { DateKey, NewTodoInput, Todo } from "@kuaiban/shared";
import type { TodoRepository } from "./repository";
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
    const todo = createTodo(input, { now: this.clock(), ...(opts.id ? { id: opts.id } : {}) });
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

  /** 编辑内容 / 时间 / 提醒 / 重复规则 */
  async edit(
    todo: Todo,
    patch: Parameters<typeof updateTodo>[1],
  ): Promise<Todo> {
    const next = updateTodo(todo, patch, this.clock());
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
