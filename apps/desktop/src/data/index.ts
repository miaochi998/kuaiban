/**
 * 存储装配（外壳层的适配器选择）
 *
 * 这是"依赖倒置"的最后一环：界面和状态层只认 `TodoRepository` 接口，
 * 由这里决定底下到底是 SQLite 还是内存。
 *
 * ## 为什么返回的是"句柄"而不是裸的仓储
 *
 * 退化成内存存储意味着**用户这次记的东西不会保存**。这种事绝不能悄悄发生 ——
 * 界面上必须看得见。所以把"用了哪种存储、为什么退化"一并交给调用方。
 * （顺带：纯浏览器里调样式 / 跑 Playwright 时走的也是这条退化路径，属预期行为。）
 *
 * ## 为什么打开数据库要带超时
 *
 * 真实踩过的坑：数据库打开环节一旦卡住，状态层就永远停在"未就绪"，
 * 界面永远显示"正在读取…" —— 用户看不到自己刚记下的东西，也不知道出了什么事。
 * **一个转不完的圈，远比一句明确的错误糟糕。**
 */

import { MemoryTodoRepository, type TodoRepository } from "@kuaiban/core";
import { createSqliteTodoRepository } from "./sqlite-todo-repository";

/** 打开本地数据库最多等多久；超过就退化，并把原因摆到界面上 */
const OPEN_TIMEOUT_MS = 8_000;

export type RepositoryKind = "sqlite" | "memory";

export interface RepositoryHandle {
  repo: TodoRepository;
  kind: RepositoryKind;
  /** kind === "memory" 时说明退化的原因 */
  reason?: string;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export async function createTodoRepository(): Promise<RepositoryHandle> {
  try {
    const repo = await withTimeout(
      createSqliteTodoRepository(),
      OPEN_TIMEOUT_MS,
      `打开本地数据库超时（超过 ${OPEN_TIMEOUT_MS / 1000} 秒没有响应）`,
    );
    return { repo, kind: "sqlite" };
  } catch (err) {
    const reason = describe(err);
    console.warn("[快办] SQLite 不可用，退化为内存存储（数据不会保存）", err);
    return { repo: new MemoryTodoRepository(), kind: "memory", reason };
  }
}

export type { TodoRepository };
