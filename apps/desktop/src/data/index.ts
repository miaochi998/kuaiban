/**
 * 存储装配（外壳层的适配器选择）
 *
 * 这是"依赖倒置"的最后一环：界面和状态层只认 `TodoRepository` 接口，
 * 由这里决定底下到底是 SQLite 还是内存。
 *
 * 为什么要有内存兜底：`pnpm dev` 之外，界面也能在纯浏览器里打开调样式
 * （`vite` 直接跑时没有 Tauri 环境）。那种情况下退化成内存存储，
 * 数据不保存，但样式、交互、布局全都能调。**这是个开发便利，不是产品功能。**
 */

import { MemoryTodoRepository, type TodoRepository } from "@kuaiban/core";
import { createSqliteTodoRepository } from "./sqlite-todo-repository";

export async function createTodoRepository(): Promise<TodoRepository> {
  try {
    return await createSqliteTodoRepository();
  } catch (err) {
    console.warn(
      "[快办] SQLite 不可用，退化为内存存储 —— 数据不会保存。若在浏览器里调样式，这是预期行为。",
      err,
    );
    return new MemoryTodoRepository();
  }
}

export type { TodoRepository };
