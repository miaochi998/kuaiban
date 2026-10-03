/**
 * 提醒引擎（外壳层）
 *
 * 把纯逻辑（`lib/reminder-queue.ts`）接到定时器、声音、展开面板这些**平台效果**上。
 *
 * ## 三级递进（业务逻辑文档 §6.2）
 *
 * - **L1 静默提示**：到点瞬间 —— 窄条闪动 + 红色角标 + 响一声。**不抢焦点、不弹窗**。
 *   用户可能正在打字或开会，这时候弹东西盖住屏幕是最讨人厌的做法。
 * - **L2 气泡**：到点 1 分钟仍未处理 —— 才认为"确实被忽略了"，自动展开面板显示提醒卡片。
 * - **L3 累积**：仍不处理就只留着角标，**不重复弹窗**。
 *
 * ## 提醒风暴合并
 *
 * 卡片天然就是合并的：多件事同时到点显示在一张卡里，不会弹 N 个窗口。
 *
 * ## 免打扰
 *
 * 默认 22:00–07:00：只闪图标，不响声音、不自动弹面板。
 * 用户主动悬停时仍然能看到卡片 —— 安静不等于藏起来。
 */

import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_QUIET_HOURS,
  ESCALATE_AFTER_MS,
  dueReminders,
  isQuietTime,
  type QuietHours,
} from "@kuaiban/core";
import {
  activeReminders,
  escalating,
  newlyAppeared,
  type QueuedReminder,
} from "../lib/reminder-queue";
import { useTodoStore } from "./todos";

/** 轮询间隔。5 秒足够让"一分钟升级"准时，又几乎不耗资源 */
const POLL_MS = 5_000;

/**
 * 自动弹出的提醒卡片最多"按住"多久不收起。
 *
 * 为什么要按住：卡片刚弹出来，鼠标又不在挂件上时，前端收不到 mouseleave，
 * 只剩 Rust 那道"鼠标移开 3 秒"的兜底 —— 卡片 3 秒就被收走，等于没提醒。
 *
 * 为什么只按住一会儿：一直按着，面板就会永远杵在屏幕上。提醒没处理完时，
 * **红色窄条 + 角标**才是长期信号（业务逻辑文档说的 L3：只累积角标，不重复弹窗）。
 */
const HOLD_OPEN_MS = 120_000;

/** 推后选项（业务逻辑文档 §6.2 的四个按钮） */
export const SNOOZE_SHORT_MS = 10 * 60_000;
export const SNOOZE_LONG_MS = 60 * 60_000;

// ─────────────────────────────────────────────────────────────
// 设置（存本地；免打扰与声音开关）
// ─────────────────────────────────────────────────────────────

export interface ReminderSettings {
  soundEnabled: boolean;
  quietHours: QuietHours;
}

const SETTINGS_KEY = "kuaiban.reminder.settings.v1";

const DEFAULT_SETTINGS: ReminderSettings = {
  soundEnabled: true,
  quietHours: DEFAULT_QUIET_HOURS,
};

function loadSettings(): ReminderSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReminderSettings>;
    return {
      soundEnabled: parsed.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled,
      quietHours:
        parsed.quietHours && typeof parsed.quietHours === "object"
          ? parsed.quietHours
          : DEFAULT_SETTINGS.quietHours,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(next: ReminderSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 存不下就用默认值，不影响提醒本身 */
  }
}

// ─────────────────────────────────────────────────────────────
// 状态
//
// 推后 / 静音**刻意不写进 todo**：它们是"用户对提醒的处理动作"，不是业务事实。
// 写进 todo 会污染领域模型，还会被同步到别的设备上 —— 那就成了别人替你静音。
// ─────────────────────────────────────────────────────────────

const todoStore = useTodoStore();

const settings = ref<ReminderSettings>(loadSettings());
const snoozed = ref<ReadonlyMap<string, number>>(new Map());
const muted = ref<ReadonlySet<string>>(new Set());
const escalated = ref<ReadonlySet<string>>(new Set());

/** 由轮询更新的"当前时刻"。单独放一个是为了让 computed 能跟着刷新 */
const tickAt = ref(Date.now());

let timer: ReturnType<typeof setInterval> | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let previousKeys: ReadonlySet<string> = new Set();
let firstTick = true;

// ─────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────

/** 当前该展示的提醒（已去掉静音的、推后未到期的） */
const active = computed<QueuedReminder[]>(() =>
  activeReminders({
    due: dueReminders(todoStore.todos.value, new Date(tickAt.value)),
    snoozed: snoozed.value,
    muted: muted.value,
    nowMs: tickAt.value,
  }),
);

const activeCount = computed(() => active.value.length);

/** 其中"错过太久"的条数（软件没开着 / 电脑睡了很久） */
const missedCount = computed(() => active.value.filter((i) => i.missed).length);

const inQuietHours = computed(() =>
  isQuietTime(new Date(tickAt.value), settings.value.quietHours),
);

/** 该不该出声：开关打开、且不在免打扰时段 */
const audible = computed(() => settings.value.soundEnabled && !inQuietHours.value);

// ─────────────────────────────────────────────────────────────
// 平台效果
// ─────────────────────────────────────────────────────────────

/**
 * 提醒音。
 *
 * 用 Web Audio 合成而不是打包一个音频文件：体积为 0、不需要额外资源、音色随时可调。
 * 两声上行比单音更容易被注意到，又不至于像警报。
 *
 * 声音不是关键功能 —— 放不出来只是少一点提示，所以失败一律静默放弃，
 * **绝不能因为音频环境有问题把提醒本身搞挂**。
 */
function playChime(): void {
  try {
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();

    const start = ctx.currentTime;
    const notes: [number, number][] = [
      [0, 784], // G5
      [0.16, 1046.5], // C6
    ];
    for (const [offset, freq] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.34);
    }
    // 播完就关掉，别一直占着音频设备
    globalThis.setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch (err) {
    console.warn("[快办] 提醒音播放失败（不影响提醒本身）", err);
  }
}

function setHoldOpen(hold: boolean): void {
  void invoke("set_hold_open", { hold }).catch(() => {});
}

/** 到点了：把面板滑出来给用户看，并暂时按住不让它被兜底收起 */
function revealPanel(): void {
  setHoldOpen(true);
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    setHoldOpen(false);
  }, HOLD_OPEN_MS);
  void invoke("set_expanded", { expanded: true }).catch(() => {});
}

/** 提醒都处理完了就没必要继续按住 */
function releaseHoldWhenIdle(): void {
  if (activeCount.value > 0 || holdTimer === null) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  setHoldOpen(false);
}

// ─────────────────────────────────────────────────────────────
// 轮询
// ─────────────────────────────────────────────────────────────

function tick(): void {
  tickAt.value = Date.now();
  const items = active.value;

  // L1：新出现的 → 响一声。
  // 首次 tick 不响：那是开机时把"错过的"一次性补出来，一启动就叮一声会让人莫名其妙。
  const fresh = newlyAppeared(previousKeys, items);
  if (!firstTick && fresh.length > 0 && audible.value) playChime();
  previousKeys = new Set(items.map((i) => i.key));

  // L2：到点超过 1 分钟还没处理 → 弹面板
  const toEscalate = escalating(escalated.value, items, ESCALATE_AFTER_MS);
  if (toEscalate.length > 0) {
    const next = new Set(escalated.value);
    for (const item of toEscalate) next.add(item.key);
    escalated.value = next;

    // 两种情况下不自动弹面板：
    // · 免打扰时段 —— 只累积角标
    // · 刚开机那一次 —— 那是把"我不在的时候错过的"一次性补出来，
    //   一启动就跳个面板出来会让人莫名其妙。红窄条已经在提示了。
    if (!firstTick && !inQuietHours.value) revealPanel();
  }

  firstTick = false;
  releaseHoldWhenIdle();
}

export function startReminders(): void {
  if (timer !== null) return;
  tick();
  timer = setInterval(tick, POLL_MS);
}

export function stopReminders(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  setHoldOpen(false);
}

// ─────────────────────────────────────────────────────────────
// 用户对提醒的处理
// ─────────────────────────────────────────────────────────────

/** 完成（勾掉这一次） */
export async function completeReminder(item: QueuedReminder): Promise<void> {
  await todoStore.toggleDone(item.todo, item.occurrenceDate);
  releaseHoldWhenIdle();
}

/** 推后：过一会儿再提醒。到期后它会重新出现在列表里，并重新走一遍 L1→L2 */
export function snoozeReminder(item: QueuedReminder, ms: number): void {
  const next = new Map(snoozed.value);
  next.set(item.key, Date.now() + ms);
  snoozed.value = next;

  // 从"已升级"里移除，这样推后到期后会重新走 L1（响一声）→ L2（弹面板）
  const cleared = new Set(escalated.value);
  cleared.delete(item.key);
  escalated.value = cleared;

  releaseHoldWhenIdle();
}

/** 今天不再提醒这一条（明天该响还是响） */
export function muteReminder(item: QueuedReminder): void {
  const next = new Set(muted.value);
  next.add(item.key);
  muted.value = next;
  releaseHoldWhenIdle();
}

/** 全部推后 */
export function snoozeAll(ms: number): void {
  const next = new Map(snoozed.value);
  const until = Date.now() + ms;
  for (const item of active.value) next.set(item.key, until);
  snoozed.value = next;
  escalated.value = new Set();
  releaseHoldWhenIdle();
}

/** 今天都不再提醒 */
export function muteAll(): void {
  const next = new Set(muted.value);
  for (const item of active.value) next.add(item.key);
  muted.value = next;
  releaseHoldWhenIdle();
}

// ─────────────────────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────────────────────

export function setSoundEnabled(enabled: boolean): void {
  settings.value = { ...settings.value, soundEnabled: enabled };
  saveSettings(settings.value);
}

export function setQuietEnabled(enabled: boolean): void {
  settings.value = {
    ...settings.value,
    quietHours: { ...settings.value.quietHours, enabled },
  };
  saveSettings(settings.value);
}

/** 试听：让用户确认声音能不能听见 */
export function previewChime(): void {
  playChime();
}

export function useReminderStore() {
  return {
    // 状态
    active,
    activeCount,
    missedCount,
    settings,
    inQuietHours,
    // 动作
    completeReminder,
    snoozeReminder,
    muteReminder,
    snoozeAll,
    muteAll,
    setSoundEnabled,
    setQuietEnabled,
    previewChime,
  };
}
