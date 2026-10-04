/**
 * 内存实现 —— 用于单元测试、纯浏览器预览，以及未来的临时离线缓存。
 *
 * 它是**纯内存**的：不碰文件、不碰数据库、不碰网络。
 * 因此可以放心地放在大脑包里（不违反"零平台依赖"）。
 *
 * 写入时做一次显式克隆：模拟真实存储"存的是值快照"的语义，
 * 避免调用方拿到返回值后继续改对象，"偷偷改了库里的数据"。
 * （刻意不用 structuredClone —— 那会要求把 DOM / Node 的 lib 拉进大脑。）
 */

import type { RepeatRule, Todo } from "@kuaiban/shared";
import type { TodoRepository } from "./repository";

function cloneRepeat(rule: RepeatRule): RepeatRule {
  switch (rule.kind) {
    case "weekly":
      return { kind: "weekly", weekdays: [...rule.weekdays] };
    case "monthly":
      return { kind: "monthly", days: [...rule.days] };
    default:
      return { kind: rule.kind };
  }
}

function clone(todo: Todo): Todo {
  return {
    ...todo,
    repeat: cloneRepeat(todo.repeat),
    skippedDates: [...todo.skippedDates],
  };
}

export class MemoryTodoRepository implements TodoRepository {
  private readonly rows = new Map<string, Todo>();

  constructor(initial: readonly Todo[] = []) {
    for (const todo of initial) this.rows.set(todo.id, clone(todo));
  }

  async list(): Promise<Todo[]> {
    return [...this.rows.values()].map(clone);
  }

  async upsert(todos: readonly Todo[]): Promise<void> {
    for (const todo of todos) this.rows.set(todo.id, clone(todo));
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  /** 仅测试用：当前记录条数 */
  get size(): number {
    return this.rows.size;
  }
}
