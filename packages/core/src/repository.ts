/**
 * 存储端口（Port）—— 依赖倒置的那条"接口"
 *
 * 大脑只认这个接口，**完全不知道**底下是 SQLite、是服务端、还是内存。
 * 好处：
 * - 换存储不动大脑（以后加服务端同步，也只需要再实现一个）
 * - 单元测试用内存实现，不需要任何数据库
 * - "零平台依赖"这条铁律在这里体现得最直接：本文件里没有一个平台 API
 *
 * 实现方（适配器）放在外壳层，见 `apps/desktop/src/data/`。
 */

import type { Todo } from "@kuaiban/shared";

/** 待办仓储。刻意做小：只有"全部读出来"和"写回去"两件事 */
export interface TodoRepository {
  /**
   * 读出**全部**待办，包含已软删除的（`deletedAt !== null`）。
   *
   * 为什么连软删除的也要读：同步规则是"删除优先"，
   * 服务端需要看到"这条被删了"这个事实，而不是"查不到这条"。
   * 视图层过滤掉它们即可（`isAlive`）。
   */
  list(): Promise<Todo[]>;

  /** 按 id 覆盖写入（不存在则插入）。批量传入以减少往返 */
  upsert(todos: readonly Todo[]): Promise<void>;
}
