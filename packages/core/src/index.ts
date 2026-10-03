/**
 * 快办 —— 大脑（@kuaiban/core）
 *
 * ## 这个包是什么
 * 本项目全部的**业务规则**：一天的边界、逾期顺延、重复任务、提醒调度、视图切分。
 *
 * ## 铁律（整个项目最重要的约束）
 * **本包里绝不允许出现任何平台专属代码。**
 * 不许 import 窗口、托盘、通知、文件系统、SQLite、HTTP 客户端、任何 Electron / Tauri API。
 * 只允许纯 TypeScript + 本包内的模块。
 *
 * 检验方法很朴素：**本包能在纯 Node 环境下跑单元测试、不报任何平台错误**，
 * 就证明它真的干净。守不住这条，将来每上一个平台都要改一遍大脑 ——
 * 那"多端技术栈互通"就废了（见 docs/技术选型-v0.1.md 第 2 节）。
 *
 * ## 依赖方向
 * ```
 *   界面 / 服务端 / 各平台外壳
 *            ↓  只能单向依赖
 *        @kuaiban/core        ← 本包（大脑）
 *            ↓
 *      @kuaiban/shared        ← 领域类型与常量
 * ```
 * 反向依赖一律禁止。
 */

export * from "./date";
export * from "./repeat";
export * from "./todo";
export * from "./view";
export * from "./reminder";
export * from "./repository";
export * from "./memory-repository";
export * from "./service";
export * from "./sync";

// 领域类型从 shared 透出，调用方只需要依赖 core 一个包
export type {
  AuthUser,
  DateKey,
  IsoWeekday,
  NewTodoInput,
  RepeatRule,
  SyncState,
  SyncStatus,
  TimeOfDay,
  Todo,
  TodoStatus,
} from "@kuaiban/shared";

export {
  DEFAULT_DAY_BOUNDARY_HOUR,
  NO_REPEAT,
  REPEAT_LABELS,
} from "@kuaiban/shared";
