/**
 * SQLite 存储适配器 —— 外壳层的"平台实现"
 *
 * 四层架构里「平台桥接层」的一个具体适配器：大脑只认 `TodoRepository` 接口
 * （`@kuaiban/core` 的 repository.ts），本文件负责把那个接口翻译成 SQL。
 *
 * ⚠️ 边界：**业务规则一行都不许写在这里**。
 * 本文件只做两件事：开库、把读写转发给 SQL。行 ↔ 实体的映射在 `./todo-row.ts`
 * （拆出去是为了它能在纯 Node 下被单测覆盖，不用起 Tauri）。
 *
 * 表结构由 Rust 侧的迁移建出来（见 `src-tauri/src/lib.rs` 的 `migrations()`），
 * 两边的列名/列数必须一一对应 —— 这是一条跨语言契约，`TODO_COLUMNS` 是它的单一事实来源。
 */

import Database from "@tauri-apps/plugin-sql";
import type { Todo, TodoRepository } from "@kuaiban/core";
import {
  DB_URL,
  UPSERT_SQL,
  describeError,
  rowToTodo,
  todoToParams,
  type TodoRow,
} from "./todo-row";

/**
 * 建立 SQLite 仓储。
 *
 * **失败时会抛异常**，这是刻意的：`data/index.ts` 靠捕获它来决定是否退化成
 * 内存存储（纯浏览器里调样式时没有 Tauri 环境，这是预期路径）。
 * 所以这里不要自己吞掉错误返回一个"假仓储" —— 那会让真实的数据丢失被掩盖。
 */
export async function createSqliteTodoRepository(): Promise<TodoRepository> {
  const db = await Database.load(DB_URL);

  return {
    /**
     * 读出全部待办，**包含已软删除的**（`deletedAt !== null`）。
     *
     * 不能顺手加 `WHERE deleted_at IS NULL`：同步规则是"删除优先"，
     * 上层（以及将来的服务端）需要看到"这条被删了"这个事实。
     * 视图过滤是大脑的 `isAlive()` 负责的。
     *
     * 不加 ORDER BY：排序规则（按时间、无时间的排最后）属于大脑的 `sortForList`，
     * 在 SQL 里再排一次只会造成两套排序逻辑打架。
     */
    async list(): Promise<Todo[]> {
      let rows: TodoRow[];
      try {
        rows = (await db.select("SELECT * FROM todos")) as TodoRow[];
      } catch (err) {
        throw new Error(`[快办] 读取待办失败：${describeError(err)}`);
      }
      return rows.map(rowToTodo);
    },

    async upsert(todos: readonly Todo[]): Promise<void> {
      if (todos.length === 0) return;

      // 逐条写。
      // 刻意不用 BEGIN/COMMIT 包一批：tauri-plugin-sql 的 execute 走连接池，
      // 分开调用不保证落在同一条连接上，手工事务反而可能"提交了个寂寞"。
      // 每次操作最多也就几行，顺序写足够；将来真要批量导入再考虑单语句多值插入。
      for (const todo of todos) {
        try {
          await db.execute(UPSERT_SQL, todoToParams(todo));
        } catch (err) {
          // 写失败必须炸出来。静默吞掉的话，用户会以为"记下了"，
          // 实际上重启之后东西就没了 —— 这是最糟糕的一种失败。
          throw new Error(
            `[快办] 保存待办失败（id=${todo.id}，内容=「${todo.title}」）：${describeError(err)}`,
          );
        }
      }
    },

    /**
     * 清空本机全部待办。
     *
     * 用途只有一个：用户明确选择"放弃这台电脑上属于别的账号的数据"。
     * 这里必须是**真删**，不能用软删除 —— 软删除等于把上一个人的待办
     * 标记为已删再同步出去，反而会去改别的账号的数据。
     */
    async clear(): Promise<void> {
      try {
        await db.execute("DELETE FROM todos");
      } catch (err) {
        throw new Error(`[快办] 清空本地待办失败：${describeError(err)}`);
      }
    },
  };
}
