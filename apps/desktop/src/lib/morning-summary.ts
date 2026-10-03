/**
 * 全天事项的「早上汇总」
 *
 * 业务逻辑文档 §6.2：没设时间的事项**不逐条打扰**，只在早上约定时间汇总一次。
 *
 * 为什么需要它：一个没定时间的待办（"买咖啡豆"）永远等不到"到点"那一刻，
 * 所以它永远不会出现在提醒里。如果不管，这类事就会被彻底忘掉 —— 而它们
 * 恰恰是"顺手就能做、但一忙就忘了"的那一类。
 *
 * 为什么只汇总一次：全天事项没有"几点"可言，反复提醒等于噪音。
 * 汇总一次把用户的注意力引过去，剩下的交给清单本身。
 */

import { atTimeOnDate, type DateKey, type TimeOfDay } from "@kuaiban/core";

/** 默认汇总时刻。上班后半小时左右，人已经坐下来看今天要干什么了 */
export const DEFAULT_SUMMARY_TIME: TimeOfDay = "09:00";

export interface MorningSummaryInput {
  /** 今天有多少条"没定时间"且还没做的事 */
  allDayCount: number;
  businessDate: DateKey;
  now: Date;
  /** 约定的汇总时刻 */
  summaryTime: TimeOfDay;
  /** 已经汇总过的业务日（null = 从没汇总过） */
  lastSummarizedDay: DateKey | null;
}

/**
 * 现在该不该显示早上汇总。
 *
 * 四个条件缺一不可：
 * 1. 确实有没定时间的事 —— 没有就别打扰
 * 2. 这个业务日还没汇总过 —— 一天只汇总一次
 * 3. 已经过了约定的汇总时刻
 * 4. 时刻合法
 */
export function shouldSummarize(input: MorningSummaryInput): boolean {
  if (input.allDayCount <= 0) return false;
  if (input.lastSummarizedDay === input.businessDate) return false;

  const at = atTimeOnDate(input.businessDate, input.summaryTime);
  if (!at) return false;

  return input.now.getTime() >= at.getTime();
}

/** 汇总文案。说清"几件""什么性质"，不列具体内容（内容就在下面的清单里） */
export function summaryText(count: number): string {
  return `今天还有 ${count} 件没定时间的事`;
}
