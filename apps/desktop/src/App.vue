<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface WidgetStatus {
  expanded: boolean;
  pinned: boolean;
}

/** 鼠标移开后延迟多久收起（与产品文档一致：1.5 秒） */
const COLLAPSE_DELAY_MS = 1500;

const expanded = ref(false);
const pinned = ref(false);
/** 鼠标当前是否在面板范围内 —— 决定"输入结束后"要不要开始收起倒计时 */
const pointerInside = ref(false);

let unlisten: UnlistenFn | null = null;
let leaveTimer: number | null = null;

function clearLeaveTimer() {
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

/**
 * 开始（或重开）收起倒计时。
 *
 * 三个"不能收"的条件，缺一个都会出问题：
 * 1. `pinned` —— 用户钉住了，本来就不该收
 * 2. `pointerInside` —— 鼠标还在面板上（例如刚输入完，鼠标没动过）
 * 3. 输入框有焦点 —— **用户正在打字**。
 *    打字时手会离开鼠标，鼠标很容易滑出窗口；不挡这一条，
 *    1.5 秒后面板就会被收走、草稿白打。
 *    （Rust 侧还有一道 3 秒兜底，靠 `activatable` 标志做同样的判断。）
 */
function scheduleCollapse() {
  if (pinned.value) return;
  if (pointerInside.value) return;
  if (draftEl.value !== null && document.activeElement === draftEl.value) return;

  clearLeaveTimer();
  leaveTimer = window.setTimeout(() => {
    void invoke("set_expanded", { expanded: false });
  }, COLLAPSE_DELAY_MS);
}

/** 输入结束：交还键盘焦点，并重新评估是否该开始收起倒计时 */
function onInputBlur() {
  releaseKeyboard();
  // 不重新调一次的话，取消焦点后就没人再触发收起了 —— 面板会反向卡住
  scheduleCollapse();
}

function togglePin() {
  pinned.value = !pinned.value;
  void invoke("set_pinned", { pinned: pinned.value });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    const el = draftEl.value;
    if (el && el === document.activeElement) {
      // 先交还键盘焦点，再收起（收起后就不该再占着别人的键盘输入了）
      el.blur();
      releaseKeyboard();
      clearLeaveTimer();
      void invoke("set_expanded", { expanded: false });
      return;
    }
    if (!pinned.value) {
      clearLeaveTimer();
      void invoke("set_expanded", { expanded: false });
    }
  }
}

onMounted(async () => {
  // 冷启动时同步一次状态（Rust 是唯一事实来源）
  try {
    const status = await invoke<WidgetStatus>("get_status");
    expanded.value = status.expanded;
    pinned.value = status.pinned;
  } catch {
    /* 非 Tauri 环境（纯浏览器调试）忽略 */
  }

  unlisten = await listen<WidgetStatus>("widget:state", (event) => {
    expanded.value = event.payload.expanded;
    pinned.value = event.payload.pinned;
    // 面板收起 = 不再需要打字，立刻交还键盘焦点（后端也会再兜一次）
    if (!event.payload.expanded) {
      draftEl.value?.blur();
      releaseKeyboard();
    }
  });

  document.documentElement.addEventListener("mouseleave", () => {
    pointerInside.value = false;
    scheduleCollapse();
  });
  document.documentElement.addEventListener("mouseenter", () => {
    pointerInside.value = true;
    clearLeaveTimer();
  });
  // 兜底：某些 WebView 只给 mouseout
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) {
      pointerInside.value = false;
      scheduleCollapse();
    }
  });
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  unlisten?.();
  clearLeaveTimer();
  window.removeEventListener("keydown", onKeydown);
});

// ─────────────────────────────────────────────────────────────
// 原型用的假数据（仅用于验证窗口行为与视觉方向，尚未接大脑）
// ─────────────────────────────────────────────────────────────
const overdue = [
  { id: 1, text: "给客户回电话", days: 3, urgent: true },
  { id: 2, text: "报销单提交", days: 1, urgent: false },
];

const today = ref([
  { id: 3, text: "周会", time: "09:30", repeat: "每周", done: false },
  { id: 4, text: "评审原型稿", time: "14:00", repeat: "", done: false },
  { id: 5, text: "交周报", time: "17:00", repeat: "", done: false },
  { id: 6, text: "买咖啡豆", time: "", repeat: "", done: false },
]);

const doneItems = [
  { id: 7, text: "回复邮件", time: "08:40" },
  { id: 8, text: "提交考勤", time: "09:10" },
  { id: 9, text: "打印合同", time: "10:25" },
];

const showDone = ref(false);
const draft = ref("");
const draftEl = ref<HTMLInputElement | null>(null);

// ─────────────────────────────────────────────────────────────
// Windows「不抢焦点」与「输入框能打字」如何共存（外壳行为，非业务逻辑）
//
// 挂件平时带 WS_EX_NOACTIVATE：点面板任何地方都不会夺走用户当前窗口的焦点，
// 代价是这个窗口永远拿不到键盘焦点 —— 输入框打不了字。
// 折中：只有用户明确点了输入框，才向后端申请「临时可激活」，
// 拿到键盘焦点后立刻聚焦输入框；失焦 / 面板收起 / 按 Esc 立刻交还。
// ─────────────────────────────────────────────────────────────
async function grabKeyboard() {
  try {
    await invoke("set_activatable", { activatable: true });
  } catch {
    /* 非 Tauri 环境（纯浏览器调试）忽略 */
  }
}

function releaseKeyboard() {
  void invoke("set_activatable", { activatable: false }).catch(() => {});
}

const remaining = () => today.value.filter((t) => !t.done).length + overdue.length;

function addTodo() {
  const text = draft.value.trim();
  if (!text) return;
  today.value.push({ id: Date.now(), text, time: "", repeat: "", done: false });
  draft.value = "";
}
</script>

<template>
  <div class="widget" :class="{ expanded, pinned }">
    <!-- ── 收起时露在屏幕最右侧的窄条 ────────────────────── -->
    <div class="strip" aria-hidden="true">
      <span class="strip-badge">{{ remaining() }}</span>
      <span class="strip-grip"></span>
    </div>

    <!-- ── 展开的面板 ──────────────────────────────────── -->
    <section class="panel">
      <header class="head">
        <div class="head-date">10月3日<span>周五</span></div>
        <div class="head-count">还有 <b>{{ remaining() }}</b> 件</div>
        <button
          class="pin"
          :class="{ on: pinned }"
          :title="pinned ? '取消钉住' : '钉住（鼠标移开也不收起）'"
          @click="togglePin"
        >
          📌
        </button>
      </header>

      <div class="scroll">
        <!-- 昨日未完成 -->
        <div v-if="overdue.length" class="group overdue">
          <div class="group-title">⚠ 昨日未完成<span class="n">{{ overdue.length }}</span></div>
          <div v-for="it in overdue" :key="it.id" class="item">
            <span class="check"></span>
            <div class="body">
              <div class="text">{{ it.text }}</div>
              <div class="meta">
                <span class="delay" :class="{ hot: it.urgent }">拖了 {{ it.days }} 天</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 今天 -->
        <div class="group">
          <div class="group-title">今天</div>
          <div v-for="it in today" :key="it.id" class="item" :class="{ done: it.done }">
            <span class="check" :class="{ done: it.done }" @click="it.done = !it.done"></span>
            <div class="body">
              <div class="text">{{ it.text }}</div>
              <div class="meta">
                <span v-if="it.time" class="time">{{ it.time }}</span>
                <span v-if="it.repeat" class="repeat">🔁 {{ it.repeat }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 已完成 -->
        <div class="group">
          <div class="group-title clickable" @click="showDone = !showDone">
            ✓ 已完成<span class="n muted">{{ doneItems.length }}</span>
            <span class="caret" :class="{ open: showDone }">›</span>
          </div>
          <template v-if="showDone">
            <div v-for="it in doneItems" :key="it.id" class="item done">
              <span class="check done"></span>
              <div class="body">
                <div class="text">{{ it.text }}</div>
                <div class="meta"><span>{{ it.time }}</span></div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <footer class="foot">
        <input
          ref="draftEl"
          v-model="draft"
          class="add"
          type="text"
          placeholder="＋ 添加今天的待办，回车即存…"
          @mousedown="grabKeyboard"
          @blur="onInputBlur"
          @keydown.enter="addTodo"
        />
        <div class="hint">
          原型：鼠标移到屏幕最右侧窄条即展开，移开 1.5 秒后自动收起，📌 可钉住
        </div>
      </footer>
    </section>
  </div>
</template>

<style>
/* ─────────────────────────────────────────────────────────────
   全局：窗口透明、无滚动、不选中文本
   ───────────────────────────────────────────────────────────── */
* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
  overflow: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
    "Microsoft YaHei", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
}

.widget {
  position: relative;
  width: 100%;
  height: 100%;
}

/* ─────────────────────────────────────────────────────────────
   收起时露出的窄条
   ───────────────────────────────────────────────────────────── */
.strip {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 152px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  background: linear-gradient(180deg, #5b87fb 0%, #3b6ef6 100%);
  border-radius: 9px 0 0 9px;
  box-shadow: -3px 0 14px rgba(59, 110, 246, 0.38);
  transition: opacity 0.16s ease, transform 0.2s ease;
}

.widget.expanded .strip {
  opacity: 0;
  transform: translateY(-50%) translateX(24px);
}

.strip-badge {
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: #fff;
  color: #3b6ef6;
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
}

.strip-grip {
  width: 2px;
  height: 30px;
  border-radius: 1px;
  background: rgba(255, 255, 255, 0.7);
}

/* ─────────────────────────────────────────────────────────────
   展开面板
   ───────────────────────────────────────────────────────────── */
.panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(15, 23, 42, 0.07);
  border-right: none;
  border-radius: 14px 0 0 14px;
  box-shadow: -10px 0 32px rgba(15, 23, 42, 0.13);
  overflow: hidden;
  transform: translateX(100%);
  opacity: 0;
  transition: transform 0.24s cubic-bezier(0.22, 0.61, 0.36, 1),
    opacity 0.18s ease;
}

.widget.expanded .panel {
  transform: translateX(0);
  opacity: 1;
}

/* 头部 */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 13px 10px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  flex: none;
}

.head-date {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.01em;
}

.head-date span {
  font-size: 11px;
  font-weight: 500;
  color: #94a3b8;
}

.head-count {
  margin-left: auto;
  font-size: 11px;
  color: #64748b;
}

.head-count b {
  font-size: 13px;
  color: #3b6ef6;
}

.pin {
  width: 24px;
  height: 24px;
  flex: none;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.32;
  transition: opacity 0.15s, background 0.15s;
}

.pin:hover {
  opacity: 0.75;
  background: rgba(15, 23, 42, 0.06);
}

.pin.on {
  opacity: 1;
  background: rgba(59, 110, 246, 0.13);
}

/* 列表区 */
.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 7px 7px 2px;
  overscroll-behavior: contain;
}

.scroll::-webkit-scrollbar {
  width: 4px;
}

.scroll::-webkit-scrollbar-thumb {
  background: rgba(15, 23, 42, 0.14);
  border-radius: 2px;
}

.scroll::-webkit-scrollbar-track {
  background: transparent;
}

.group {
  margin-bottom: 4px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 3px;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  letter-spacing: 0.02em;
}

.group-title.clickable {
  cursor: pointer;
}

.group.overdue .group-title {
  color: #ea580c;
}

.group-title .n {
  padding: 1px 5px;
  border-radius: 6px;
  font-size: 10px;
  background: rgba(234, 88, 12, 0.12);
  color: #ea580c;
}

.group-title .n.muted {
  background: rgba(148, 163, 184, 0.16);
  color: #94a3b8;
}

.caret {
  margin-left: auto;
  font-size: 13px;
  color: #cbd5e1;
  transition: transform 0.15s;
}

.caret.open {
  transform: rotate(90deg);
}

/* 单条待办 */
.item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 9px;
  transition: background 0.12s;
}

.item:hover {
  background: rgba(15, 23, 42, 0.04);
}

.check {
  position: relative;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  flex: none;
  border: 1.5px solid #cbd5e1;
  border-radius: 5px;
  cursor: pointer;
  transition: border-color 0.13s, background 0.13s;
}

.check:hover {
  border-color: #3b6ef6;
}

.check.done {
  background: #3b6ef6;
  border-color: #3b6ef6;
}

.check.done::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 6px;
  height: 3px;
  border-left: 1.5px solid #fff;
  border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg);
}

.body {
  flex: 1;
  min-width: 0;
}

.text {
  font-size: 13px;
  line-height: 1.36;
  color: #1e293b;
  word-break: break-word;
}

.item.done .text {
  color: #cbd5e1;
  text-decoration: line-through;
}

.meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 2px;
  font-size: 10px;
  color: #94a3b8;
}

.meta .time {
  color: #3b6ef6;
  font-weight: 600;
}

.meta .delay {
  color: #f59e0b;
  font-weight: 600;
}

.meta .delay.hot {
  color: #dc2626;
}

/* 底部输入 */
.foot {
  flex: none;
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.add {
  width: 100%;
  padding: 9px 11px;
  border: none;
  outline: none;
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.045);
  font-family: inherit;
  font-size: 12.5px;
  color: #1e293b;
  user-select: text;
  transition: background 0.15s, box-shadow 0.15s;
}

.add::placeholder {
  color: #94a3b8;
}

.add:focus {
  background: rgba(59, 110, 246, 0.07);
  box-shadow: 0 0 0 1.5px rgba(59, 110, 246, 0.28);
}

.hint {
  margin-top: 7px;
  font-size: 10px;
  line-height: 1.5;
  color: #b6c2d2;
  text-align: center;
}
</style>
