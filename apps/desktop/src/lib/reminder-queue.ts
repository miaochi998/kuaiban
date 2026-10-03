/**
 * 提醒队列的纯逻辑
 *
 * 分成两层是为了能测：
 * - **本文件**：给定"到点的候选 + 推后记录 + 静音记录 + 当前时刻"，算出
 *   "现在该展示哪些提醒、哪些是新到的、哪些该升级"。全是纯函数，不需要浏览器。
 * - **store/reminders.ts**：把纯逻辑接到定时器、声音、展开面板这些平台效果上。
 *
 * 为什么要单独记「推后」和「静音」而不是改待办本身：
 * 它们不是业务事实，是**用户对提醒的处理动作**。明天这条待办该响还是要响，
 * 所以不能写进 todo（那会污染领域模型，也会被同步到别的设备）。
 */

import { MISSED_AFTER_MS, type DueReminder } from "@kuaiban/core";

export interface QueuedReminder extends DueReminder {
  /** 实际开始计时的时刻：推后过就是推后到期的时刻，否则等于 fireAt */
  effectiveAtMs: number;
  /** 从 effectiveAt 到现在过了多久 —— 判断该不该升级到气泡阶段 */
  ageMs: number;
  /** 错过太久（软件没开着 / 电脑睡了很久），值得特别标注 */
  missed: boolean;
}

export interface QueueInput {
  /** 大脑算出来的"已到点且未处理"的候选 */
  due: readonly DueReminder[];
  /** 推后记录：key → 推后到期的毫秒时刻 */
  snoozed: ReadonlyMap<string, number>;
  /** 今天不再提醒：key 集合 */
  muted: ReadonlySet<string>;
  nowMs: number;
}

/**
 * 当前真正该展示的提醒列表。
 *
 * 过滤顺序：
 * 1. 今天被静音的 → 去掉
 * 2. 推后还没到时间的 → 去掉（到时间后自然重新出现）
 * 3. 按"实际计时起点"排序，最该处理的排最前
 */
export function activeReminders(input: QueueInput): QueuedReminder[] {
  const out: QueuedReminder[] = [];

  for (const item of input.due) {
    if (input.muted.has(item.key)) continue;

    const snoozeUntil = input.snoozed.get(item.key) ?? 0;
    const effectiveAtMs = Math.max(item.fireAt.getTime(), snoozeUntil);
    if (effectiveAtMs > input.nowMs) continue; // 推后还没到期

    const ageMs = input.nowMs - effectiveAtMs;
    out.push({
      ...item,
      effectiveAtMs,
      ageMs,
      missed: ageMs > MISSED_AFTER_MS,
    });
  }

  out.sort((a, b) => a.effectiveAtMs - b.effectiveAtMs);
  return out;
}

/**
 * 这一轮**新出现**的提醒（上一轮还没在列表里的）。
 *
 * 用"新出现的"而不是"所有到点的"，是为了让声音只响一次：
 * 已经摆在列表里半小时的那条，不该每隔几秒再响一遍。
 */
export function newlyAppeared(
  previousKeys: ReadonlySet<string>,
  items: readonly QueuedReminder[],
): QueuedReminder[] {
  return items.filter((i) => !previousKeys.has(i.key));
}

/**
 * 该升级到气泡阶段的提醒：到点超过 `escalateAfterMs` 且还没升级过。
 *
 * 为什么要"升级"这一步：刚响的那一下是**静默提示**（闪动 + 一声），
 * 用户可能正在打字、开会，不该立刻弹东西盖住他的屏幕。
 * 一分钟还没处理，才认为"确实被忽略了"，这时才值得弹出来。
 */
export function escalating(
  alreadyEscalated: ReadonlySet<string>,
  items: readonly QueuedReminder[],
  escalateAfterMs: number,
): QueuedReminder[] {
  return items.filter((i) => !alreadyEscalated.has(i.key) && i.ageMs >= escalateAfterMs);
}
