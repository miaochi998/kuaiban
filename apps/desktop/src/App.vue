<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { fromDateKey, monthGrid, todosOnDate, type DateKey, type Todo, type TodoEdit } from "@kuaiban/core";
import EditSheet from "./components/EditSheet.vue";
import ReminderCard from "./components/ReminderCard.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import TodoRow from "./components/TodoRow.vue";
import {
  browserHintStorage,
  loadDismissedHints,
  pickHint,
  saveDismissedHints,
} from "./lib/hints";
import { parseDraft } from "./lib/parse-draft";
import { SNOOZE_SHORT_MS, startReminders, useReminderStore } from "./store/reminders";
import { useAccountStore } from "./store/account";
import { startSync, useSyncStore } from "./store/sync";
import { startUpdater } from "./store/updater";
import { useTodoStore, type PanelTab } from "./store/todos";
import ForcePasswordChange from "./components/ForcePasswordChange.vue";

// ─────────────────────────────────────────────────────────────
// 外壳行为：悬停展开 / 移开收起 / 钉住 / 不抢焦点
// （这部分是平台交互，与业务无关）
// ─────────────────────────────────────────────────────────────

interface WidgetStatus {
  expanded: boolean;
  pinned: boolean;
}

/** 鼠标移开后延迟多久收起 */
const COLLAPSE_DELAY_MS = 1500;

const expanded = ref(false);
const pinned = ref(false);
/** 鼠标是否在面板内 —— 决定"输入结束后"要不要开始收起倒计时 */
const pointerInside = ref(false);

let unlisten: UnlistenFn | null = null;
let leaveTimer: number | null = null;

const draftEl = ref<HTMLInputElement | null>(null);

function clearLeaveTimer() {
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

/**
 * 开始（或重开）收起倒计时。三个"不能收"的条件缺一不可：
 * 钉住了 / 鼠标还在面板上 / **正在打字**。
 * 打字时手会离开鼠标、鼠标容易滑出窗口，不挡最后一条就会把草稿收没。
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
  scheduleCollapse();
}

function togglePin() {
  pinned.value = !pinned.value;
  void invoke("set_pinned", { pinned: pinned.value });
}

/**
 * 输入框需要真的能打字，所以在它获得焦点期间向 Rust 申请"临时可激活"。
 * Windows 上这是让带 WS_EX_NOACTIVATE 的挂件能收到键盘的唯一办法；
 * 其它平台是空操作，但那个标志仍然要维护 —— Rust 的兜底收起靠它。
 */
async function grabKeyboard() {
  try {
    await invoke("set_activatable", { activatable: true });
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

function releaseKeyboard() {
  void invoke("set_activatable", { activatable: false }).catch(() => {});
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const el = draftEl.value;
  if (el && el === document.activeElement) {
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

onMounted(async () => {
  try {
    const status = await invoke<WidgetStatus>("get_status");
    expanded.value = status.expanded;
    pinned.value = status.pinned;
  } catch {
    // 非 Tauri 环境（浏览器里调样式 / 自动化测试）：
    // 没有"外壳"可以悬停展开，直接把面板显示出来，否则界面完全不可见。
    expanded.value = true;
  }

  try {
    unlisten = await listen<WidgetStatus>("widget:state", (event) => {
      expanded.value = event.payload.expanded;
      pinned.value = event.payload.pinned;
      if (!event.payload.expanded) {
        draftEl.value?.blur();
        releaseKeyboard();
      }
    });
  } catch {
    /* 非 Tauri 环境忽略 */
  }

  document.documentElement.addEventListener("mouseleave", () => {
    pointerInside.value = false;
    scheduleCollapse();
  });
  document.documentElement.addEventListener("mouseenter", () => {
    pointerInside.value = true;
    clearLeaveTimer();
  });
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) {
      pointerInside.value = false;
      scheduleCollapse();
    }
  });
  window.addEventListener("keydown", onKeydown);

  // 提醒轮询。放在挂载之后启动：它依赖待办列表已经能读到。
  startReminders();
  // 同步：没登录时它什么都不做（离线优先）
  startSync();
  // 在线更新：后台悄悄查、悄悄下，装好了才提示重启
  startUpdater();
});

onUnmounted(() => {
  unlisten?.();
  clearLeaveTimer();
  window.removeEventListener("keydown", onKeydown);
});

// ─────────────────────────────────────────────────────────────
// 业务界面（数据全部来自大脑 + 存储）
// ─────────────────────────────────────────────────────────────

const store = useTodoStore();
const {
  view,
  activeTab,
  ready,
  fatalError,
  storageWarning,
  loadPhase,
  remainingCount,
  visibleTodos,
  visibleDateKey,
  lastError,
  notice,
  justAddedId,
} = store;

const showDone = ref(false);
const draft = ref("");

// ── 到点提醒（引擎在 store/reminders.ts）──
const reminders = useReminderStore();
const {
  active: activeReminders,
  activeCount,
  missedCount,
  morningSummary,
} = reminders;

const showSettings = ref(false);

// ── 账号与同步（离线优先：不登录也能正常用，只是不同步）──
const account = useAccountStore();
const sync = useSyncStore();
/**
 * 同步状态点：**只在有话要说的时候出现**。
 *
 * 一开始我让它常驻显示（灰=未登录、绿=已同步），结果用户的第一反应是
 * "这个小灰点是什么意思？" —— 一个没有文字的状态点，用户没法自己搞明白，
 * 而且它会一直被误读成"某个按钮"。
 * 现在改成：一切正常时不显示；只有「同步中 / 出错 / 有待上传」才冒出来。
 * 那时它是个**提示**，而不是一个需要用户去猜的装饰。
 */
const syncHint = computed<{ tone: string; title: string } | null>(() => {
  if (!account.loggedIn.value) return null;
  const now = sync.status.value;
  if (now.state === "syncing") return { tone: "syncing", title: "正在同步…" };
  if (now.state === "error") return { tone: "error", title: sync.lastError.value ?? "同步出错" };
  if (now.pendingCount > 0) {
    return { tone: "pending", title: `还有 ${now.pendingCount} 条没上传（点开设置看详情）` };
  }
  return null;
});

const editingTodo = ref<Todo | null>(null);

async function onSaveEdit(edit: TodoEdit) {
  const target = editingTodo.value;
  if (!target) return;
  if (await store.editTodo(target, edit)) {
    editingTodo.value = null;
    store.flashNotice("已保存");
  }
}

async function onRemoveEdit() {
  const target = editingTodo.value;
  if (!target) return;
  if (await store.removeTodo(target)) {
    editingTodo.value = null;
    store.flashNotice("已删除");
  }
}

/** 窄条角标：有未处理的到点时显示提醒条数（更要紧），否则显示今日未完成数 */
const badgeCount = computed(() =>
  activeCount.value > 0 ? activeCount.value : remainingCount.value,
);

const TABS: { key: PanelTab; label: string }[] = [
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "inbox", label: "随笔" },
  { key: "calendar", label: "日历" },
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const todayLabel = computed(() => {
  const d = fromDateKey(view.value.businessDate);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
});

const tomorrowLabel = computed(() => {
  const d = fromDateKey(view.value.tomorrowDate);
  return `明天 ${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
});

/**
 * 当前页签下，新待办应该落到哪一天。
 *
 * - 今天 / 明天：对应的业务日
 * - 随笔：`null`（未排期）
 * - **日历：选中的那一天** —— 这就是"未来要做的事，现在先记到那天"的做法
 */
const draftTargetDate = computed<DateKey | null>(() => {
  switch (activeTab.value) {
    case "tomorrow":
      return view.value.tomorrowDate;
    case "inbox":
      return null;
    case "calendar":
      return calSelected.value;
    default:
      return view.value.businessDate;
  }
});

/**
 * 这里能不能加待办。
 * 日历页签下必须先点一个日期 —— 不然不知道该加到哪天。
 */
const canAddHere = computed(
  () => activeTab.value !== "calendar" || calSelected.value !== null,
);

/** 把 `2026-10-15` 说成「10月15日」 */
function friendlyDate(key: DateKey): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const placeholder = computed(() => {
  switch (activeTab.value) {
    case "tomorrow":
      return "添加明天的事，如 10:00 客户拜访 / 每周六 例会";
    case "inbox":
      return "随手记一条，之后可以排期…";
    case "calendar": {
      const d = calSelected.value;
      return d ? `添加到 ${friendlyDate(d)}，如 9:30 交周报` : "";
    }
    default:
      return "添加今天的事，如 9:30 交周报 / 每周六 10:00 例会";
  }
});

/** 输入框里有内容才允许提交（按钮的禁用态据此决定） */
const canSubmit = computed(() => draft.value.trim().length > 0);

// ── 用法提示 ──
// 需要"教一次"的技巧只出现一次（点 ✕ 或下次启动就不再出现），
// 教完之后只留一行很淡的常驻备忘。理由见 lib/hints.ts 顶部注释。
const hintStorage = browserHintStorage();
const dismissedHints = ref<Set<string>>(loadDismissedHints(hintStorage));

const activeHint = computed(() =>
  pickHint({
    tab: activeTab.value,
    hasTarget: canAddHere.value,
    dismissed: dismissedHints.value,
  }),
);

function dismissHint() {
  const next = new Set(dismissedHints.value);
  next.add(activeHint.value.hint.id);
  dismissedHints.value = next;
  saveDismissedHints(hintStorage, next);
}

const emptyHint = computed(() => {
  switch (activeTab.value) {
    case "tomorrow":
      return "明天还没有安排";
    case "inbox":
      return "随笔是待办的暂存区\n想到什么先丢进来，之后一键排期";
    default:
      return "今天还没有待办\n在下面输入框敲回车就能加一条";
  }
});

/**
 * 极速捕获：支持在输入内容前面直接写时间，例如 `9:30 交周报`。
 * 解析逻辑抽在 `./lib/parse-draft.ts`（纯函数、有单测覆盖各种写法与误判边界）。
 */

async function submitDraft() {
  const raw = draft.value.trim();
  if (!raw) return;

  const { title, time, repeat } = parseDraft(raw);
  if (!title) return;

  const date = draftTargetDate.value;
  // 日历页签下没选日期就没有目标，静默返回（界面这时也不会显示输入框）
  if (date === null && activeTab.value !== "inbox") return;

  const created = await store.addTodo({ title, date, time, repeat });

  // 只有真的写进去了才清空输入框。
  // 失败时保留内容 —— 用户不用重打一遍，而且"字还在"本身就是一种反馈。
  if (created) {
    draft.value = "";
    // 重复待办的起始日会被对齐到第一个真正符合规则的日子
    // （「工作日 打卡」建在周六 → 起始日推到周一）。
    // 这件事**必须说出来** —— 用户明明选的今天，结果跑到下周一去了，
    // 不说清楚就是"我的待办怎么不见了"。
    store.flashNotice(
      created.date && created.date !== date
        ? `已添加「${title}」· 按重复规则从 ${friendlyDate(created.date)} 开始`
        : created.date
          ? `已添加「${title}」到 ${friendlyDate(created.date)}`
          : `已添加「${title}」`,
    );
    // 接着记下一条：点按钮会让输入框失焦，这里主动还回去
    draftEl.value?.focus();
    void grabKeyboard();
  }
}

async function onToggle(todo: Todo) {
  await store.toggleDone(todo, visibleDateKey.value);
}

// ── 日历 ──
const calCursor = ref(new Date());
const calYear = computed(() => calCursor.value.getFullYear());
const calMonth = computed(() => calCursor.value.getMonth() + 1);
const calCells = computed(() => monthGrid(calYear.value, calMonth.value));
const calSelected = ref<DateKey | null>(null);

const calSelectedTodos = computed(() =>
  calSelected.value ? todosOnDate(store.todos.value, calSelected.value) : [],
);

/** 选中日期（不可空）。用于把 prop 传给 TodoRow 时避免可空类型 */
const calSelectedKey = computed<DateKey>(
  () => calSelected.value ?? view.value.businessDate,
);

function countOn(key: DateKey): number {
  return todosOnDate(store.todos.value, key).length;
}

async function toggleOnSelectedDay(todo: Todo) {
  if (!calSelected.value) return;
  await store.toggleDone(todo, calSelected.value);
}

function shiftMonth(delta: number) {
  const d = calCursor.value;
  calCursor.value = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  calSelected.value = null;
}
</script>

<template>
  <div class="widget" :class="{ expanded, pinned }">
    <!-- ── 收起时露在屏幕最右侧的窄条 ────────────────────── -->
    <div class="strip" :class="{ alerting: activeCount > 0 }" aria-hidden="true">
      <span v-if="badgeCount > 0" class="strip-badge" :class="{ urgent: activeCount > 0 }">
        {{ badgeCount }}
      </span>
      <span class="strip-grip"></span>
    </div>

    <!-- ── 展开的面板 ──────────────────────────────────── -->
    <section class="panel">
      <!--
        首次登录必须先改密码 —— 盖住整个面板，改完才放行。
        服务端早就标了 mustChangePassword，客户端一直没理会（见该组件的说明）。
      -->
      <ForcePasswordChange v-if="account.mustChangePassword.value" />
      <header class="head">
        <div class="head-date">{{ todayLabel }}</div>
        <div class="head-count">还有 <b>{{ remainingCount }}</b> 件</div>
        <!-- 只在有话要说时出现，见 syncHint 的说明 -->
        <button
          v-if="syncHint"
          class="sync-dot"
          :class="syncHint.tone"
          type="button"
          :title="syncHint.title"
          @click="showSettings = true"
        ></button>
        <button
          class="head-icon"
          type="button"
          title="设置"
          :class="{ on: showSettings }"
          @click="showSettings = !showSettings"
        >⚙</button>
        <button
          class="pin"
          :class="{ on: pinned }"
          type="button"
          :title="pinned ? '取消钉住' : '钉住（鼠标移开也不收起）'"
          @click="togglePin"
        >📌</button>
      </header>

      <!-- 编辑中：整块换成编辑面板，避免 340px 里塞两套界面 -->
      <EditSheet
        v-if="editingTodo"
        :todo="editingTodo"
        :business-date="view.businessDate"
        @save="onSaveEdit"
        @cancel="editingTodo = null"
        @remove="onRemoveEdit"
      />

      <!-- 设置同样**占满整个面板**：点设置就是要专心改设置，
           旁边还堆着提醒卡片、页签、底部输入框，只会让人不知道看哪儿 -->
      <SettingsPanel v-else-if="showSettings" @close="showSettings = false" />

      <template v-else>
      <!--
        提醒卡片放在页签之上：无论用户当前在看哪个页签，到点的事都立刻可见。
        没有提醒时它整块不渲染，不占地方。
      -->
      <ReminderCard
        v-if="activeReminders.length > 0"
        :items="activeReminders"
        :missed-count="missedCount"
        @complete="reminders.completeReminder"
        @snooze="(item) => reminders.snoozeReminder(item, SNOOZE_SHORT_MS)"
        @mute="reminders.muteReminder"
        @snooze-all="() => reminders.snoozeAll(SNOOZE_SHORT_MS)"
        @mute-all="reminders.muteAll"
      />

      <!--
        早上汇总：没定时间的事永远等不到"到点"，只能在这个时刻被提一次。
        不逐条打扰，也不响声音 —— 内容就在下面的清单里，这条只是把注意力引过去。
      -->
      <div v-if="morningSummary.visible" class="morning-summary">
        <span class="ms-text">☀ {{ morningSummary.text }}</span>
        <button
          class="ms-close"
          type="button"
          title="知道了"
          @click="reminders.dismissMorningSummary()"
        >知道了</button>
      </div>

      <nav class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: activeTab === t.key }"
          type="button"
          @click="activeTab = t.key"
        >{{ t.label }}</button>
      </nav>

      <div class="scroll">
        <!-- 存不下来是比"用不了"更危险的事：用户会以为已经存好了。
             所以这条警告一直摆着，不自动消失。 -->
        <p v-if="storageWarning" class="storage-warn">⚠ {{ storageWarning }}</p>

        <p v-if="fatalError" class="fatal">
          读取本地数据失败：{{ fatalError }}
        </p>

        <p v-else-if="!ready" class="loading">{{ loadPhase }}</p>

        <!-- ── 日历页签 ── -->
        <template v-else-if="activeTab === 'calendar'">
          <div class="cal-head">
            <button class="cal-nav" type="button" @click="shiftMonth(-1)">‹</button>
            <span class="cal-title">{{ calYear }}年{{ calMonth }}月</span>
            <button class="cal-nav" type="button" @click="shiftMonth(1)">›</button>
          </div>
          <div class="cal-grid">
            <span v-for="w in ['一','二','三','四','五','六','日']" :key="w" class="cal-wd">{{ w }}</span>
            <button
              v-for="cell in calCells"
              :key="cell"
              class="cal-cell"
              :class="{
                dim: fromDateKey(cell).getMonth() + 1 !== calMonth,
                today: cell === view.businessDate,
                picked: cell === calSelected,
              }"
              type="button"
              @click="calSelected = calSelected === cell ? null : cell"
            >
              <span class="cal-day">{{ Number(cell.slice(-2)) }}</span>
              <span v-if="countOn(cell)" class="cal-dot" :data-n="Math.min(countOn(cell), 3)"></span>
            </button>
          </div>
          <template v-if="calSelected">
            <div class="group-title">{{ calSelected }} · {{ calSelectedTodos.length }} 件</div>
            <TodoRow
              v-for="todo in calSelectedTodos"
              :key="todo.id"
              :todo="todo"
              :highlight="todo.id === justAddedId"
              :date-key="calSelectedKey"
              :business-date="view.businessDate"
              @edit="editingTodo = todo"
              @toggle="toggleOnSelectedDay(todo)"
              @remove="store.removeTodo(todo)"
              @carry-over="store.moveTodoTo(todo, view.businessDate)"
            />
            <p v-if="calSelectedTodos.length === 0" class="empty small">这一天没有安排</p>
          </template>
        </template>

        <!-- ── 列表页签 ── -->
        <template v-else>
          <!-- 昨日未完成（本软件的灵魂） -->
          <div v-if="activeTab === 'today' && view.overdue.length" class="group overdue">
            <div class="group-title">
              ⚠ 昨日未完成<span class="n">{{ view.overdue.length }}</span>
              <button
                v-if="view.overdue.length > 1"
                class="carry-all"
                type="button"
                @click="store.carryOverAll()"
              >全部搬今天</button>
            </div>
            <TodoRow
              v-for="o in view.overdue"
              :key="o.todo.id"
              :todo="o.todo"
              :date-key="view.businessDate"
              :business-date="view.businessDate"
              :overdue-days="o.overdueDays"
              :needs-attention="o.needsAttention"
              @edit="editingTodo = o.todo"
              @toggle="store.toggleDone(o.todo, view.businessDate)"
              @remove="store.removeTodo(o.todo)"
              @carry-over="store.moveTodoTo(o.todo, view.businessDate)"
            />
            <p v-if="view.needsAttention.length" class="nudge">
              拖了好几天了，要不要改个时间、拆小一点，或者放弃？
            </p>
          </div>

          <!-- 当前页签的列表 -->
          <div v-if="visibleTodos.length" class="group">
            <div v-if="activeTab === 'tomorrow'" class="group-title">{{ tomorrowLabel }}</div>
            <div v-else-if="activeTab === 'inbox'" class="group-title">随笔 · 未排期</div>
            <TodoRow
              v-for="todo in visibleTodos"
              :key="todo.id"
              :todo="todo"
              :highlight="todo.id === justAddedId"
              :date-key="visibleDateKey"
              :business-date="view.businessDate"
              @edit="editingTodo = todo"
              @toggle="onToggle(todo)"
              @remove="store.removeTodo(todo)"
              @carry-over="store.moveTodoTo(todo, view.businessDate)"
            />
          </div>

          <p v-else-if="activeTab !== 'today' || !view.overdue.length" class="empty">
            {{ emptyHint }}
          </p>

          <!-- 已完成（只在今天页签） -->
          <div v-if="activeTab === 'today'" class="group">
            <button
              class="group-title clickable"
              type="button"
              @click="showDone = !showDone"
            >
              ✓ 已完成<span class="n muted">{{ view.doneToday.length }}</span>
              <span class="caret" :class="{ open: showDone }">›</span>
            </button>
            <template v-if="showDone">
              <TodoRow
                v-for="todo in view.doneToday"
                :key="todo.id"
                :todo="todo"
                :highlight="todo.id === justAddedId"
                :date-key="view.businessDate"
                :business-date="view.businessDate"
                @edit="editingTodo = todo"
                @toggle="store.toggleDone(todo, view.businessDate)"
                @remove="store.removeTodo(todo)"
                @carry-over="store.moveTodoTo(todo, view.businessDate)"
              />
            </template>
          </div>
        </template>
      </div>

      <footer class="foot">
        <!--
          操作反馈。用户反馈过"点了回车没有任何反应"——
          所以每一次写操作都必须在这里留下看得见的一句话：
          成功给一闪而过的确认，失败给留得住的错误原因。
        -->
        <p v-if="lastError" class="alert" role="alert">⚠ {{ lastError }}</p>
        <p v-else-if="notice" class="toast" role="status">✓ {{ notice }}</p>

        <div v-if="canAddHere" class="add-row">
          <input
            ref="draftEl"
            v-model="draft"
            class="add"
            type="text"
            :placeholder="placeholder"
            @mousedown="grabKeyboard"
            @blur="onInputBlur"
            @keydown.enter="submitDraft"
          />
          <!--
            发送按钮。两种提交方式都保留：回车（老手更快）与点按钮（新手直观）。

            点按钮会让输入框失焦，所以提交成功后由 `submitDraft` 主动把焦点还回来，
            用户可以接着打第二条。不靠 `@mousedown.prevent` 来"阻止失焦"：
            实测（macOS WKWebView）那样做会让 click 事件根本不触发 —— 按钮点了没反应。
            而且也不需要它：鼠标在面板内时 `scheduleCollapse` 本来就不会开始倒计时。
          -->
          <button
            class="send"
            type="button"
            :disabled="!canSubmit"
            title="添加（也可以直接按回车）"
            @click="submitDraft"
          >添加</button>
        </div>
        <!--
          用法提示。分两类：
          · coach（教学）—— 点 ✕ 之后永久不再出现
          · 常驻备忘 —— 随页签变化的淡淡一行
          日历页签下没点日期时，这里会提示"点日历上的某一天"，
          而不是把输入框藏起来让人以为"这里不能加"。
        -->
        <div class="hint-line" :class="{ coach: activeHint.coach }">
          <span class="hint-text">{{ activeHint.hint.text }}</span>
          <button
            v-if="activeHint.coach"
            class="hint-close"
            type="button"
            title="知道了，别再提示"
            @click="dismissHint"
          >✕</button>
        </div>
      </footer>
      </template>
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
   ⚠️ 跨层契约：height 必须与 Rust 侧 src-tauri/src/lib.rs 的
      STRIP_HEIGHT 常量保持一致，否则"看得见的窄条"和
      "能触发悬停的区域"会对不上。
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

/* 有未处理的到点提醒：窄条变红并持续脉动。
   这是 L1「静默提示」—— 不抢焦点、不弹窗，但足够显眼。
   用户正在打字或开会时，弹东西盖住屏幕是最讨人厌的做法。 */
.strip.alerting {
  background: linear-gradient(180deg, #fb7185 0%, #dc2626 100%);
  animation: strip-pulse 1.3s ease-in-out infinite;
}

@keyframes strip-pulse {
  0%,
  100% {
    box-shadow: -3px 0 12px rgba(220, 38, 38, 0.4);
  }
  50% {
    box-shadow: -3px 0 26px rgba(220, 38, 38, 0.95);
  }
}

.strip-badge.urgent {
  color: #dc2626;
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
  padding: 13px 13px 9px;
  flex: none;
}

.head-date {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.01em;
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

/* 页签 */
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 9px 8px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  flex: none;
}

.tab {
  flex: 1;
  padding: 5px 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: #94a3b8;
  cursor: pointer;
  transition: background 0.13s, color 0.13s;
}

.tab:hover {
  background: rgba(15, 23, 42, 0.05);
  color: #64748b;
}

.tab.on {
  background: rgba(59, 110, 246, 0.1);
  color: #3b6ef6;
  font-weight: 600;
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
  width: 100%;
  padding: 7px 8px 3px;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  letter-spacing: 0.02em;
  text-align: left;
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

.carry-all {
  margin-left: auto;
  padding: 1px 7px;
  border: none;
  border-radius: 6px;
  background: rgba(234, 88, 12, 0.12);
  font-family: inherit;
  font-size: 10px;
  color: #ea580c;
  cursor: pointer;
}

.carry-all:hover {
  background: rgba(234, 88, 12, 0.2);
}

.nudge {
  margin: 2px 8px 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.1);
  font-size: 10.5px;
  line-height: 1.5;
  color: #b45309;
}

/* 空态 / 加载 / 出错 */
.empty {
  margin: 22px 16px;
  font-size: 11.5px;
  line-height: 1.7;
  color: #b6c2d2;
  text-align: center;
  white-space: pre-line;
}

.empty.small {
  margin: 10px 16px;
}

.loading {
  margin: 22px 16px;
  font-size: 11.5px;
  color: #b6c2d2;
  text-align: center;
}

.fatal {
  margin: 16px 12px;
  padding: 9px 11px;
  border-radius: 9px;
  background: rgba(220, 38, 38, 0.07);
  font-size: 11px;
  line-height: 1.6;
  color: #b91c1c;
}

/* "数据存不下来"的常驻警告：琥珀色，不自动消失 */
.storage-warn {
  margin: 6px 8px 8px;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(245, 158, 11, 0.13);
  font-size: 10.5px;
  line-height: 1.55;
  color: #92400e;
  word-break: break-word;
}

/* ── 日历 ── */
.cal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 8px;
}

.cal-title {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: #334155;
  text-align: center;
}

.cal-nav {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: 15px;
  line-height: 1;
  color: #94a3b8;
  cursor: pointer;
}

.cal-nav:hover {
  background: rgba(15, 23, 42, 0.06);
  color: #475569;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  padding: 0 5px 6px;
}

.cal-wd {
  padding: 2px 0 4px;
  font-size: 10px;
  color: #cbd5e1;
  text-align: center;
}

.cal-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 30px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-family: inherit;
  font-size: 11.5px;
  color: #475569;
  cursor: pointer;
}

.cal-cell:hover {
  background: rgba(15, 23, 42, 0.05);
}

.cal-cell.dim {
  color: #d8e0ea;
}

.cal-cell.today {
  background: rgba(59, 110, 246, 0.1);
  color: #3b6ef6;
  font-weight: 700;
}

.cal-cell.picked {
  background: #3b6ef6;
  color: #fff;
  font-weight: 700;
}

.cal-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #3b6ef6;
}

.cal-cell.picked .cal-dot {
  background: #fff;
}

.cal-dot[data-n="2"] {
  width: 9px;
  border-radius: 2px;
}

.cal-dot[data-n="3"] {
  width: 14px;
  border-radius: 2px;
}

/* 早上汇总横幅 */
.morning-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  margin: 0 8px 8px;
  padding: 7px 10px;
  border-radius: 9px;
  background: rgba(59, 110, 246, 0.08);
  border: 1px solid rgba(59, 110, 246, 0.16);
}

.ms-text {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: #3b6ef6;
  font-weight: 600;
}

.ms-close {
  flex: none;
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(59, 110, 246, 0.14);
  font-family: inherit;
  font-size: 10px;
  color: #3b6ef6;
  cursor: pointer;
}

.ms-close:hover {
  background: rgba(59, 110, 246, 0.24);
}

/* 同步提示点：只在"同步中 / 出错 / 有待上传"时出现 */
.sync-dot {
  width: 8px;
  height: 8px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #3b6ef6;
  cursor: pointer;
}

.sync-dot.syncing {
  background: #f59e0b;
  animation: dot-pulse 1s ease-in-out infinite;
}

.sync-dot.error {
  background: #dc2626;
}

/* 头部图标按钮。原来 15px 太小不好点，放大到 26px */
.head-icon,
.pin {
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity 0.13s, background 0.13s;
}

.head-icon:hover,
.pin:hover {
  opacity: 1;
  background: rgba(15, 23, 42, 0.07);
}

.head-icon.on,
.pin.on {
  opacity: 1;
  background: rgba(59, 110, 246, 0.13);
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 底部输入 */
.foot {
  flex: none;
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

/* 用法提示：一行，很淡。教学校态时略微突出并给个关闭按钮 */
.hint-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 7px 2px 0;
  min-height: 15px;
}

.hint-text {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  line-height: 1.5;
  color: #b6c2d2;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint-line.coach {
  padding: 4px 7px;
  border-radius: 7px;
  background: rgba(59, 110, 246, 0.07);
}

.hint-line.coach .hint-text {
  color: #6b8fd8;
  text-align: left;
  white-space: normal;
}

.hint-close {
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  font-family: inherit;
  font-size: 10px;
  line-height: 1;
  color: #9db3dd;
  cursor: pointer;
}

.hint-close:hover {
  background: rgba(59, 110, 246, 0.14);
  color: #3b6ef6;
}

.add-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

/* 操作反馈：成功一闪而过，失败留得住 */
.alert {
  margin: 0 0 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(220, 38, 38, 0.08);
  font-size: 10.5px;
  line-height: 1.5;
  color: #b91c1c;
  word-break: break-word;
}

.toast {
  margin: 0 0 6px;
  padding: 6px 9px;
  border-radius: 8px;
  background: rgba(22, 163, 74, 0.09);
  font-size: 10.5px;
  line-height: 1.5;
  color: #15803d;
  animation: toast-in 0.18s ease;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.add {
  flex: 1;
  min-width: 0;
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

/* 发送按钮。空输入时禁用，避免"点了没反应"的困惑 */
.send {
  flex: none;
  padding: 0 13px;
  border: none;
  border-radius: 9px;
  background: #3b6ef6;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.send:hover:not(:disabled) {
  background: #2f5fe0;
}

.send:active:not(:disabled) {
  background: #2751c9;
}

.send:disabled {
  background: rgba(15, 23, 42, 0.07);
  color: #b6c2d2;
  cursor: default;
}
</style>
