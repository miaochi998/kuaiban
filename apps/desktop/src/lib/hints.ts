/**
 * 界面用法提示
 *
 * 为什么需要它：这个软件有不少「看一眼界面猜不到」的用法 ——
 * 时间可以直接写在输入框里、有些操作要鼠标悬停才出现、📌 是什么意思、
 * 日历里得先点一天才能加……用户明确提过「光看界面不一定知道能这么用」。
 *
 * ## 设计原则：教一次就够，然后闭嘴
 *
 * - 每条「技巧」只出现一次，点掉（或关掉软件后）就不再出现 —— 记录在本地
 * - 技巧都学完之后，输入框下面只留一行很淡的、随页签变化的用法备忘
 *
 * 挂件只有 340px 宽、560px 高，**任何常驻的说明都必须值回它占的那一行**。
 * 所以这里刻意把提示分成两类：一次性的「教」和长期的「备忘」，
 * 而不是堆一堆常在的图文说明把面板撑满。
 */

export type HintTab = "today" | "tomorrow" | "inbox" | "calendar";

export interface Hint {
  id: string;
  text: string;
  /** 只在哪些页签展示；不填 = 所有页签 */
  tabs?: HintTab[];
}

/**
 * 需要「教一次」的用法，**按优先级排列**（先教最值钱的）。
 *
 * 排序理由：极速捕获（直接写时间）是这个软件的第一条设计铁律，
 * 但它完全靠占位文字提示，一打字就看不见了 —— 最该先教。
 */
export const COACH_HINTS: Hint[] = [
  {
    id: "time-shortcut",
    text: "试试直接写时间：9:30 交周报，会自动拆开",
    tabs: ["today", "tomorrow", "inbox"],
  },
  {
    id: "repeat-keyword",
    text: "重复的事直接写：每周六 10:00 例会、每天 9:30 吃药",
    tabs: ["today", "tomorrow", "inbox"],
  },
  {
    id: "tap-to-edit",
    text: "点待办内容就能改时间、日期、重复规则",
    tabs: ["today", "tomorrow", "calendar"],
  },
  {
    id: "overdue-carry",
    text: "没做完的会自动落到「昨日未完成」，鼠标移上去可一键搬今天",
    tabs: ["today"],
  },
  {
    id: "inbox-schedule",
    text: "随笔里记下的，鼠标移上去可以「排今天」",
    tabs: ["inbox"],
  },
  {
    id: "pin-panel",
    text: "点右上角 📌 可以钉住，鼠标移开也不收起",
  },
];

/** 技巧都学完之后，长期留着的那一行备忘（很淡） */
export function fallbackHint(ctx: { tab: HintTab; hasTarget: boolean }): Hint {
  switch (ctx.tab) {
    case "today":
      return { id: "fb-today", text: "可以写「每周六 10:00 交周报」" };
    case "tomorrow":
      return { id: "fb-tomorrow", text: "下班前把明天排好，到点它会自己出现" };
    case "inbox":
      return { id: "fb-inbox", text: "点一下内容就能改时间和重复" };
    case "calendar":
      return ctx.hasTarget
        ? { id: "fb-cal-picked", text: "加完会留在这天，可以接着加" }
        : { id: "fb-cal-none", text: "点日历上的某一天，就能给那天加待办" };
  }
}

export interface PickedHint {
  hint: Hint;
  /** true = 一次性教学（带关闭按钮）；false = 常驻备忘 */
  coach: boolean;
}

/** 挑出当前该显示哪一条提示 */
export function pickHint(ctx: {
  tab: HintTab;
  /** 当前页签能不能加待办（日历下 = 是否选了日期） */
  hasTarget: boolean;
  dismissed: ReadonlySet<string>;
}): PickedHint {
  // 当前状态下"还做不了事"时（日历没选日期），必须先把该怎么做讲清楚。
  // 否则会被"📌 可以钉住"这类教学提示挤掉 —— 用户最需要的恰恰是那句操作指引。
  if (!ctx.hasTarget) return { hint: fallbackHint(ctx), coach: false };

  for (const hint of COACH_HINTS) {
    if (ctx.dismissed.has(hint.id)) continue;
    if (hint.tabs && !hint.tabs.includes(ctx.tab)) continue;
    return { hint, coach: true };
  }
  return { hint: fallbackHint(ctx), coach: false };
}

// ─────────────────────────────────────────────────────────────
// 本地记录「哪些已经教过了」
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "kuaiban.hints.dismissed.v1";

/** 只依赖 getItem/setItem，方便单测传一个假的进去 */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadDismissedHints(storage: HintStorage | null | undefined): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    // 读不出来就当没教过 —— 顶多多教一遍，不会出错
    return new Set();
  }
}

export function saveDismissedHints(
  storage: HintStorage | null | undefined,
  ids: ReadonlySet<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // 存不下也无所谓：下次再教一遍，不影响使用
  }
}

/** 取浏览器的 localStorage；拿不到（如纯 Node 测试）就返回 null */
export function browserHintStorage(): HintStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
