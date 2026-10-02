/**
 * 快办 —— 领域类型与常量
 *
 * 这里是**唯一**的领域模型事实来源：客户端（大脑）与服务端共用同一份定义。
 * 本包**不允许**依赖任何平台 API（窗口、文件、网络、数据库），只能有类型与常量。
 */

// ─────────────────────────────────────────────────────────────
// 日期与时间
// ─────────────────────────────────────────────────────────────

/**
 * 业务日 key，格式 `YYYY-MM-DD`。
 *
 * 注意它**不等于自然日**：业务日以**凌晨 04:00** 为分界（见 `DEFAULT_DAY_BOUNDARY_HOUR`）。
 * 用户熬夜到凌晨 1 点处理的事，仍然属于"今天"。
 */
export type DateKey = string;

/** 时刻，格式 `HH:mm`（24 小时制） */
export type TimeOfDay = string;

/**
 * 业务日的分界小时：04:00 之前算前一天。
 *
 * 为什么是 4 点：用户熬夜到凌晨处理"今天"的事时，日历不该已经翻页。
 */
export const DEFAULT_DAY_BOUNDARY_HOUR = 4;

// ─────────────────────────────────────────────────────────────
// 重复规则
// ─────────────────────────────────────────────────────────────

/** ISO 星期：1 = 周一 …… 7 = 周日 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * 重复规则。
 *
 * 第一版只支持这 5 种（业务逻辑文档 §6.3）：
 * 不重复 / 每天 / 每周（选周几）/ 每月（选几号）/ 工作日。
 * 刻意不做"每 N 天""每月第几个周几"这类复杂规则 —— 简单是产品要求。
 */
export type RepeatRule =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: IsoWeekday[] }
  /** days: 每月几号（1–31）。当月没有该日则本次跳过，见 core/repeat.ts */
  | { kind: "monthly"; days: number[] }
  /** 工作日 = 周一至周五 */
  | { kind: "weekdays" };

export const NO_REPEAT: RepeatRule = { kind: "none" };

/** 重复规则的界面文案 */
export const REPEAT_LABELS: Record<RepeatRule["kind"], string> = {
  none: "不重复",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  weekdays: "工作日",
};

// ─────────────────────────────────────────────────────────────
// 待办
// ─────────────────────────────────────────────────────────────

/**
 * 待办状态。
 *
 * `done` / `cancelled` 对**一次性待办**生效。
 * **重复待办**不使用 status —— 勾选完成只影响"本次"（见 `lastDoneDate`），
 * 系列永远继续（业务逻辑文档 §6.3）。
 */
export type TodoStatus = "pending" | "done" | "cancelled";

export interface Todo {
  /** 全局唯一 id（客户端生成，同步用） */
  id: string;

  /** 内容，一句话 */
  title: string;

  /**
   * 排期日（业务日 key）。
   * - `null` = **未排期 → 自动进入「随笔」区**（这是"随笔是待办暂存区"的实现方式）
   * - 有值 = 归入那一天的清单
   */
  date: DateKey | null;

  /** 时间 `HH:mm`；`null` = 全天事项（不逐条打扰，只在早上汇总） */
  time: TimeOfDay | null;

  /** 状态（重复待办不使用，见类型注释） */
  status: TodoStatus;

  /** 重复规则 */
  repeat: RepeatRule;

  /** 重复待办：最近一次被完成的**业务日**（null = 本次还没完成） */
  lastDoneDate: DateKey | null;

  /** 重复待办：被显式「跳过本次」的业务日列表 */
  skippedDates: DateKey[];

  /** 是否提醒 */
  remind: boolean;

  /** 提前多少分钟提醒（0 / 5 / 15 / 30 / 60） */
  remindBefore: number;

  /** 备注（界面折叠，展开才看到） */
  note: string;

  /** 完成时刻，ISO 8601（一次性待办用；用于"今天完成了哪些"与归档） */
  completedAt: string | null;

  /** 创建 / 更新时刻，ISO 8601（同步冲突裁决用：后改的赢） */
  createdAt: string;
  updatedAt: string;

  /**
   * 删除标记（软删除），ISO 8601。
   *
   * 同步规则是「删除优先」（业务逻辑文档 §8.3）：服务端看到 deletedAt
   * 就不再让这条记录在别的设备上"活过来"。
   */
  deletedAt: string | null;
}

/** 新建待办时的输入（其余字段由 core 补默认值） */
export interface NewTodoInput {
  title: string;
  date?: DateKey | null;
  time?: TimeOfDay | null;
  repeat?: RepeatRule;
  remind?: boolean;
  remindBefore?: number;
  note?: string;
}

// ─────────────────────────────────────────────────────────────
// 同步
// ─────────────────────────────────────────────────────────────

/**
 * 同步状态。挂件上要显示一个小状态点（业务逻辑文档 §8.5）：
 * 🟢 已同步 / 🟡 同步中 / 🔴 离线（N 条待上传）
 */
export type SyncState = "synced" | "syncing" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  /** 待上传的变更条数 */
  pendingCount: number;
  /** 最后一次成功同步的时刻，ISO 8601 */
  lastSyncedAt: string | null;
}

// ─────────────────────────────────────────────────────────────
// 账号
// ─────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  /** 登录名（管理员创建） */
  username: string;
  /** 姓名 */
  displayName: string;
  /** 是否管理员 */
  isAdmin: boolean;
  /** 是否必须先改密码（管理员给的初始密码只能用一次） */
  mustChangePassword: boolean;
}
