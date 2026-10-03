/**
 * 极速捕获的输入解析
 *
 * 这个软件的第一条设计铁律是「**极速捕获** —— 记录任何东西不超过 2 秒，
 * 不许选日期、选分类、选优先级」。所以时间必须能直接在输入框里打出来：
 *
 *     9:30 交周报      → 内容「交周报」，提醒时间 09:30
 *     09：30 交周报    → 全角冒号也认
 *     9:30交周报       → 不空格也认
 *     9:30，交周报     → 跟个中文逗号也认
 *
 * 刻意只用**开头的时间**（和 Todoist 等工具一致的惯例）。
 * 不解析"交周报 9:30"：待办内容里出现数字太常见（"订 3 个会议室"），
 * 从右侧猜时间会产生大量误判，那比让用户多打一次冒号糟糕得多。
 */

import { normalizeTimeOfDay, type TimeOfDay } from "@kuaiban/core";

export interface ParsedDraft {
  title: string;
  time: TimeOfDay | null;
}

/**
 * 开头的时间：`9:30` / `09：30` / `9:5`，
 * 后面可以跟任意空白与一个分隔符（半角逗号、中文逗号、顿号、冒号）。
 */
const LEADING_TIME = /^(\d{1,2})\s*[:：]\s*(\d{1,2})\s*[,，、:：]?\s*([\s\S]*)$/;

export function parseDraft(raw: string): ParsedDraft {
  const text = raw.trim();
  if (text.length === 0) return { title: "", time: null };

  const m = LEADING_TIME.exec(text);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    const title = (m[3] ?? "").trim();
    // 光秃秃一个「9:30」：当成标题，不替用户猜"你是不是想设个提醒"
    if (title.length > 0) {
      const time = normalizeTimeOfDay(`${m[1]}:${m[2]}`);
      // normalizeTimeOfDay 会挡掉 25:70 这类非法时刻，此时整体当标题
      if (time) return { title, time };
    }
  }

  return { title: text, time: null };
}
