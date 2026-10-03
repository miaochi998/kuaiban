/**
 * 极速捕获的输入解析
 *
 * 这个软件的第一条设计铁律是「**极速捕获** —— 记录任何东西不超过 2 秒，
 * 不许选日期、选分类、选优先级」。所以时间和重复规则都必须能直接在输入框里打出来：
 *
 *     9:30 交周报          → 内容「交周报」，09:30
 *     下午2：30去游泳       → 内容「去游泳」，14:30
 *     每天 9:30 吃药        → 内容「吃药」，09:30，每天重复
 *     每周六 10:00 周会     → 内容「周会」，10:00，每周六
 *     每月15号交房租        → 内容「交房租」，每月 15 号
 *     工作日 打卡           → 内容「打卡」，工作日
 *
 * ## 两个反复出现的取舍
 *
 * **一、只认开头的表达式。**
 * 待办内容里出现数字太常见（"订 3 个会议室"、"交周报 9:30"），
 * 从右侧或中间猜时间会产生大量误判 —— 那比让用户多打一个冒号糟糕得多。
 *
 * **二、识别失败一律降级，绝不抛异常。**
 * 解析只是"帮你省一步"，不是"必须过关的关卡"。任何拿不准的情况，
 * 整串原样当标题 + 无时间 + 不重复，用户看到的就是自己打的那句话。
 */

import {
  NO_REPEAT,
  normalizeRepeatRule,
  normalizeTimeOfDay,
  type IsoWeekday,
  type RepeatRule,
  type TimeOfDay,
} from "@kuaiban/core";

export interface ParsedDraft {
  title: string;
  time: TimeOfDay | null;
  repeat: RepeatRule;
}

// ─────────────────────────────────────────────────────────────
// 时间
// ─────────────────────────────────────────────────────────────

/**
 * 时段词怎么改小时。
 *
 * 规则来自中文口语习惯，不是简单的 ±12：
 * - `中午1点` 是 13:00，但 `中午11点` 是 11:00 —— 所以中午只对 1–6 点加 12
 * - `晚上12点` 是 00:00（午夜），不是 12:00
 * - 已经写成 24 小时制的（`下午14:30`）不再加
 *
 * `凌晨12点` 特判成 00:00：中文里"凌晨"就是深夜，"凌晨12点"只可能指午夜。
 * 而 `上午12点` / `早上12点` 保持 12:00 —— 那才是"正午"的常见说法。
 * 两者看起来矛盾，其实符合各自的语感，所以分别处理。
 */
const PERIOD_HOUR: Record<string, (hour: number) => number> = {
  上午: (h) => h,
  早上: (h) => h,
  凌晨: (h) => (h === 12 ? 0 : h),
  中午: (h) => (h >= 1 && h <= 6 ? h + 12 : h),
  下午: (h) => (h < 12 ? h + 12 : h),
  傍晚: (h) => (h < 12 ? h + 12 : h),
  晚上: (h) => (h === 0 || h === 12 ? 0 : h < 12 ? h + 12 : h),
};

/**
 * 开头的时间表达式。两种写法：
 *   冒号式：`9:30` / `09：30` / `9:5`
 *   中文式：`9点` / `9点半` / `2点30` / `2点30分`
 * 前面都可以带一个时段词（`下午2：30`）。
 */
const LEADING_TIME =
  /^(?:(上午|早上|凌晨|中午|下午|傍晚|晚上)\s*)?(?:(\d{1,2})\s*[:：]\s*(\d{1,2})|(\d{1,2})\s*点\s*(?:(?:(\d{1,2})\s*分?)|(半))?)/;

interface TimeHit {
  end: number;
  time: TimeOfDay;
}

function matchTimeAt(text: string, start: number): TimeHit | null {
  const m = LEADING_TIME.exec(text.slice(start));
  if (!m) return null;

  let hour: number;
  let minute: number;

  if (m[2] !== undefined && m[3] !== undefined) {
    // 冒号式
    hour = Number(m[2]);
    minute = Number(m[3]);
  } else if (m[4] !== undefined) {
    // 中文式
    hour = Number(m[4]);
    minute = m[5] !== undefined ? Number(m[5]) : m[6] === "半" ? 30 : 0;
  } else {
    return null;
  }

  const adjust = m[1] !== undefined ? PERIOD_HOUR[m[1]] : undefined;
  if (adjust) hour = adjust(hour);

  // 交给大脑归一化：它会挡掉 25:00 / 9:70 / 调整后越界的小时
  const time = normalizeTimeOfDay(`${hour}:${minute}`);
  if (!time) return null;

  return { end: start + m[0].length, time };
}

// ─────────────────────────────────────────────────────────────
// 重复
// ─────────────────────────────────────────────────────────────

const WEEKDAY: Record<string, IsoWeekday> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

interface RepeatHit {
  end: number;
  repeat: RepeatRule;
  /**
   * 允许紧跟着直接接内容（中间没有空格或标点）。
   *
   * 中文不像英文有词边界，用户就是会写「每天吃苹果」。
   * 但**不是所有关键词都敢这么放开** —— 见 `工作日` 的处理。
   */
  allowConcatenation: boolean;
}

function matchRepeatAt(text: string, start: number): RepeatHit | null {
  const rest = text.slice(start);

  // 每天 / 每日
  if (rest.startsWith("每天") || rest.startsWith("每日")) {
    return { end: start + 2, repeat: { kind: "daily" }, allowConcatenation: true };
  }

  // 工作日 / 每个工作日
  //
  // ⚠️ 唯一一个**必须**有分隔符或到结尾的重复词。
  // 因为「工作日志」「工作日报」「工作人员」都以「工作日」开头，
  // 一旦允许直接接内容，用户打「工作日报」就会被吃掉前三个字、只剩「报」。
  // 「每天吃苹果」那种放开是划算的，这里不划算 —— 关键词撞上常用词了。
  const weekdayRule = /^(?:每个)?工作日/.exec(rest);
  if (weekdayRule) {
    return {
      end: start + weekdayRule[0].length,
      repeat: { kind: "weekdays" },
      allowConcatenation: false,
    };
  }

  // 每周X：X 可以多个连写（每周一三五），也可以用顿号/逗号分隔（每周一、三、五）
  const weekly = /^每周\s*([一二三四五六日天](?:\s*[、,，]?\s*[一二三四五六日天])*)/.exec(rest);
  if (weekly && weekly[1] !== undefined) {
    // ⚠️ 「每周一次大扫除」里的「每周一」不是星期一，是"每一周…一次"。
    // 紧跟量词（次/个/遍/场/趟/回）时判定为后者，整串留给用户当内容。
    // 宁可识别不出重复（用户可以在编辑面板里补），也**不能凭空生成"每周一"** ——
    // 错误的数据比没有数据糟糕得多。
    if (/^[次个遍场趟回]/.test(rest.slice(weekly[0].length))) {
      return null;
    }
    const weekdays: IsoWeekday[] = [];
    for (const ch of weekly[1]) {
      const day = WEEKDAY[ch];
      if (day !== undefined) weekdays.push(day);
    }
    // 交给大脑归一化：去重 + 排序（「每周三一三」→ [1,3]）
    const rule = normalizeRepeatRule({ kind: "weekly", weekdays });
    if (rule.kind !== "none") {
      return { end: start + weekly[0].length, repeat: rule, allowConcatenation: true };
    }
  }

  // 每月N号 / 每月N日
  const monthly = /^每月\s*(\d{1,2})\s*[号日]/.exec(rest);
  if (monthly && monthly[1] !== undefined) {
    const rule = normalizeRepeatRule({ kind: "monthly", days: [Number(monthly[1])] });
    // 归一化会把 0 号、32 号这类过滤掉并退化成 none —— 此时不认，
    // 让整串原样当标题（「每月32号团建」不该被吃掉前四个字）
    if (rule.kind !== "none") {
      return { end: start + monthly[0].length, repeat: rule, allowConcatenation: true };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/** 表达式后面可以跟的分隔符：空白、半角/中文逗号、顿号、冒号 */
const SEPARATORS = /^[\s,，、:：]+/;

function skipSeparators(text: string, pos: number): number {
  const m = SEPARATORS.exec(text.slice(pos));
  return m ? pos + m[0].length : pos;
}

/** 匹配结束位置后面是不是"直接接着内容"（既不是结尾，也不是分隔符） */
function continuesWithContent(text: string, end: number): boolean {
  if (end >= text.length) return false;
  return !SEPARATORS.test(text.slice(end));
}

export function parseDraft(raw: string): ParsedDraft {
  const text = raw.trim();
  if (text.length === 0) return { title: "", time: null, repeat: NO_REPEAT };

  let pos = 0;
  let time: TimeOfDay | null = null;
  let repeat: RepeatRule = NO_REPEAT;

  // 时间和重复可以任意顺序出现、可以只出现一个、可以都不出现。
  // 最多两个前缀，所以两轮足够。
  for (let round = 0; round < 2; round++) {
    let consumed = false;

    if (time === null) {
      const hit = matchTimeAt(text, pos);
      if (hit) {
        time = hit.time;
        pos = skipSeparators(text, hit.end);
        consumed = true;
      }
    }

    if (!consumed && repeat.kind === "none") {
      const hit = matchRepeatAt(text, pos);
      // 不允许直接接内容的关键词（见 `工作日`），必须后面是分隔符或结尾
      if (hit && (hit.allowConcatenation || !continuesWithContent(text, hit.end))) {
        repeat = hit.repeat;
        pos = skipSeparators(text, hit.end);
        consumed = true;
      }
    }

    if (!consumed) break;
  }

  const title = text.slice(pos).trim();

  // 只有前缀、没有内容（光秃秃一个「9:30」或「每天」）→ 整串当标题。
  // 不替用户猜"你是不是想设个提醒" —— 一条没有内容的待办毫无意义。
  if (title.length === 0) return { title: text, time: null, repeat: NO_REPEAT };

  return { title, time, repeat };
}
