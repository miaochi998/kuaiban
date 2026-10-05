<script setup lang="ts">
/**
 * 编辑面板
 *
 * 为什么必须有它：原来一条待办加进去之后**只能删或勾，改不了任何字段** ——
 * 忘了写时间的补不上，"每周六要做的事"也根本建不出来（数据模型支持重复规则，
 * 但界面上没有任何入口）。这两件事的根因都是"没有编辑入口"。
 *
 * 设计取舍：**一个面板改完所有东西，点一次保存一次写入**。
 * 不拆成"改时间""改重复"多个入口 —— 那会让用户为了一件小事翻好几层。
 */

import { computed, ref } from "vue";
import {
  describeRepeat,
  fromDateKey,
  addDays,
  normalizeTimeOfDay,
  type DateKey,
  type IsoWeekday,
  type RepeatRule,
  type TimeOfDay,
  type Todo,
  type TodoEdit,
} from "@kuaiban/core";

const props = defineProps<{
  todo: Todo;
  /** 当前业务日，用来算"今天/明天" */
  businessDate: DateKey;
}>();

const emit = defineEmits<{
  (e: "save", edit: TodoEdit): void;
  (e: "cancel"): void;
  (e: "remove"): void;
}>();

// ── 本地草稿（点保存之前不动真实数据）──

const title = ref(props.todo.title);
const date = ref<DateKey | null>(props.todo.date);
const timeText = ref<TimeOfDay | "">(props.todo.time ?? "");

/**
 * 时间不再让用户手打，改成点选。
 *
 * ## 为什么换掉文本输入
 *
 * 文本输入要求用户"写对格式"：全角冒号、`9点`、`下午2点半`、中间多打一个空格……
 * 每一样都可能被判非法。**而这些负担其实没必要由用户承担** —— 时间就那么多种，
 * 点选比手打更快、也永远不会错。
 *
 * 需要"随手写时间"的场景并没有丢：**主输入框**（"9:30 交周报"）
 * 仍然支持自然语言解析，那是最高频的入口。
 */
const showTimePicker = ref(false);
const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** 分钟按 5 分钟一档；需要更细的分钟时用右侧的 ±1 微调 */
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const pickedHour = computed(() => {
  const t = normalizeTimeOfDay(timeText.value);
  return t ? Number(t.slice(0, 2)) : 9;
});
const pickedMinute = computed(() => {
  const t = normalizeTimeOfDay(timeText.value);
  return t ? Number(t.slice(3, 5)) : 0;
});

function setTime(hour: number, minute: number): void {
  timeText.value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` as TimeOfDay;
}

function nudgeMinute(delta: number): void {
  const total = (pickedHour.value * 60 + pickedMinute.value + delta + 1440) % 1440;
  setTime(Math.floor(total / 60), total % 60);
}
const repeatKind = ref<RepeatRule["kind"]>(props.todo.repeat.kind);
const weekdays = ref<IsoWeekday[]>(
  props.todo.repeat.kind === "weekly" ? [...props.todo.repeat.weekdays] : [],
);
const monthDaysText = ref(
  props.todo.repeat.kind === "monthly" ? props.todo.repeat.days.join("、") : "",
);

const WEEK_LABELS: { value: IsoWeekday; label: string }[] = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 7, label: "日" },
];

const tomorrow = computed(() => addDays(props.businessDate, 1));

/**
 * 时间不再有"格式错误"这种状态 —— 用户是点选的，不可能点错。
 * 保留一个恒为空的变量，是为了不改动下面 canSave 的判定结构。
 */
const timeError = computed(() => "");

/** 重复规则是否已经选齐（每周要选到星期几、每月要填到几号） */
const repeatError = computed(() => {
  if (repeatKind.value === "weekly" && weekdays.value.length === 0) return "请选是星期几";
  if (repeatKind.value === "monthly" && parseMonthDays().length === 0) return "请填每月几号";
  return "";
});

const canSave = computed(
  () => title.value.trim().length > 0 && !timeError.value && !repeatError.value,
);

function parseMonthDays(): number[] {
  return monthDaysText.value
    .split(/[、,，\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
}

function buildRepeat(): RepeatRule {
  switch (repeatKind.value) {
    case "daily":
      return { kind: "daily" };
    case "weekdays":
      return { kind: "weekdays" };
    case "weekly":
      return { kind: "weekly", weekdays: [...weekdays.value].sort((a, b) => a - b) };
    case "monthly":
      return { kind: "monthly", days: parseMonthDays() };
    default:
      return { kind: "none" };
  }
}

function toggleWeekday(day: IsoWeekday) {
  const set = new Set(weekdays.value);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  weekdays.value = [...set] as IsoWeekday[];
}

function save() {
  if (!canSave.value) return;
  emit("save", {
    title: title.value.trim(),
    date: date.value,
    time: timeText.value.trim() === "" ? null : normalizeTimeOfDay(timeText.value),
    repeat: buildRepeat(),
  });
}

const REPEAT_OPTIONS: { kind: RepeatRule["kind"]; label: string }[] = [
  { kind: "none", label: "不重复" },
  { kind: "daily", label: "每天" },
  { kind: "weekdays", label: "工作日" },
  { kind: "weekly", label: "每周" },
  { kind: "monthly", label: "每月" },
];

function friendlyDate(key: DateKey): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 当前设置的预览，让用户保存前就能确认 */
const preview = computed(() => {
  const parts: string[] = [];
  parts.push(date.value ? friendlyDate(date.value) : "未排期");
  parts.push(timeText.value.trim() || "全天");
  const r = buildRepeat();
  if (r.kind !== "none") parts.push(describeRepeat(r));
  return parts.join(" · ");
});
</script>

<template>
  <div class="edit-sheet">
    <header class="es-head">
      <span class="es-title">编辑待办</span>
      <button class="es-close" type="button" title="取消" @click="emit('cancel')">✕</button>
    </header>

    <div class="es-body">
      <input
        v-model="title"
        class="es-input es-title-input"
        type="text"
        placeholder="要做什么"
        @keydown.enter="save"
        @keydown.esc="emit('cancel')"
      />

      <!-- 日期 -->
      <div class="es-row">
        <span class="es-label">日期</span>
        <div class="es-quick">
          <button
            class="es-chip"
            :class="{ on: date === businessDate }"
            type="button"
            @click="date = businessDate"
          >今天</button>
          <button
            class="es-chip"
            :class="{ on: date === tomorrow }"
            type="button"
            @click="date = tomorrow"
          >明天</button>
          <button
            class="es-chip"
            :class="{ on: date === null }"
            type="button"
            @click="date = null"
          >不排期</button>
        </div>
      </div>
      <input v-model="date" class="es-input small es-date" type="date" />

      <!-- 时间：点选，不手打 -->
      <div class="es-row">
        <span class="es-label">时间</span>
        <span class="es-hint">不设 = 全天事项，不逐条提醒</span>
      </div>

      <!-- 收起态：一行显示当前时间，点开选 -->
      <div class="es-time-row">
        <button class="es-time-btn" type="button" @click="showTimePicker = !showTimePicker">
          <span :class="{ 'es-time-off': !timeText }">{{ timeText || "全天" }}</span>
          <span class="es-caret">{{ showTimePicker ? "▲" : "▼" }}</span>
        </button>
        <button
          v-if="timeText"
          class="es-chip"
          type="button"
          @click="timeText = ''"
        >设为全天</button>
      </div>

      <!-- 展开态：小时 / 分钟点选，加 5 分钟微调 -->
      <div v-if="showTimePicker" class="es-picker">
        <div class="es-picker-label">几点</div>
        <div class="es-picker-grid">
          <button
            v-for="h in HOURS"
            :key="h"
            class="es-chip tiny"
            :class="{ on: pickedHour === h }"
            type="button"
            @click="setTime(h, pickedMinute)"
          >{{ h }}</button>
        </div>

        <div class="es-picker-label">几分</div>
        <div class="es-picker-grid">
          <button
            v-for="m in MINUTES"
            :key="m"
            class="es-chip tiny"
            :class="{ on: pickedMinute === m }"
            type="button"
            @click="setTime(pickedHour, m)"
          >{{ String(m).padStart(2, "0") }}</button>
        </div>

        <div class="es-time-row" style="margin-top: 8px">
          <button class="es-chip" type="button" @click="nudgeMinute(-5)">−5 分钟</button>
          <button class="es-chip" type="button" @click="nudgeMinute(5)">+5 分钟</button>
          <button class="es-chip" type="button" @click="setTime(pickedHour, 0)">整点</button>
        </div>
      </div>

      <!-- 重复 -->
      <div class="es-row">
        <span class="es-label">重复</span>
      </div>
      <div class="es-quick wrap">
        <button
          v-for="opt in REPEAT_OPTIONS"
          :key="opt.kind"
          class="es-chip"
          :class="{ on: repeatKind === opt.kind }"
          type="button"
          @click="repeatKind = opt.kind"
        >{{ opt.label }}</button>
      </div>

      <div v-if="repeatKind === 'weekly'" class="es-quick wrap es-sub">
        <button
          v-for="w in WEEK_LABELS"
          :key="w.value"
          class="es-chip round"
          :class="{ on: weekdays.includes(w.value) }"
          type="button"
          @click="toggleWeekday(w.value)"
        >{{ w.label }}</button>
      </div>

      <div v-if="repeatKind === 'monthly'" class="es-sub">
        <input
          v-model="monthDaysText"
          class="es-input small es-month-days"
          type="text"
          placeholder="每月几号，如 1、15"
        />
      </div>

      <p v-if="repeatError" class="es-error">{{ repeatError }}</p>

      <p class="es-preview">{{ preview }}</p>
    </div>

    <footer class="es-foot">
      <button class="es-btn danger" type="button" @click="emit('remove')">删除</button>
      <button class="es-btn" type="button" @click="emit('cancel')">取消</button>
      <button class="es-btn primary" type="button" :disabled="!canSave" @click="save">保存</button>
    </footer>
  </div>
</template>

<style scoped>
.edit-sheet {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.es-head {
  display: flex;
  align-items: center;
  flex: none;
  padding: 12px 13px 8px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
}

.es-title {
  flex: 1;
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.es-close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: #94a3b8;
  cursor: pointer;
}

.es-close:hover {
  background: rgba(15, 23, 42, 0.06);
}

.es-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 4px;
}

.es-input {
  width: 100%;
  padding: 8px 10px;
  border: none;
  outline: none;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.05);
  font-family: inherit;
  font-size: 12.5px;
  color: #1e293b;
  user-select: text;
}

.es-input:focus {
  background: rgba(59, 110, 246, 0.08);
  box-shadow: 0 0 0 1.5px rgba(59, 110, 246, 0.28);
}

.es-input.small {
  margin-top: 6px;
  padding: 6px 9px;
  font-size: 11.5px;
}

.es-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 12px 0 0;
}

.es-label {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
}

.es-hint {
  font-size: 10px;
  color: #a8b6c8;
}

.es-quick {
  display: flex;
  gap: 5px;
}

.es-quick.wrap {
  flex-wrap: wrap;
  margin-top: 6px;
}

.es-sub {
  margin-top: 6px;
}

.es-time-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.es-time-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border: 1px solid #e3e7ec;
  border-radius: 8px;
  background: #fbfcfd;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.es-time-btn:hover {
  border-color: #c9d3df;
}

.es-time-off {
  color: #9aa4b2;
}

.es-caret {
  font-size: 10px;
  color: #9aa4b2;
}

.es-picker {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid #e3e7ec;
  border-radius: 10px;
  background: #fbfcfd;
}

.es-picker-label {
  margin: 6px 0 4px;
  font-size: 12px;
  color: #8b94a1;
}

.es-picker-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
}

.es-chip.tiny {
  padding: 5px 0;
  font-size: 12px;
}

.es-chip {
  padding: 5px 10px;
  border: none;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.05);
  font-family: inherit;
  font-size: 11.5px;
  color: #64748b;
  cursor: pointer;
  transition: background 0.13s, color 0.13s;
}

.es-chip:hover {
  background: rgba(15, 23, 42, 0.09);
}

.es-chip.on {
  background: rgba(59, 110, 246, 0.14);
  color: #3b6ef6;
  font-weight: 600;
}

.es-chip.round {
  width: 28px;
  padding: 5px 0;
  text-align: center;
}

.es-error {
  margin: 5px 0 0;
  font-size: 10px;
  color: #dc2626;
}

.es-preview {
  margin: 14px 0 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.035);
  font-size: 10.5px;
  color: #94a3b8;
}

.es-foot {
  display: flex;
  gap: 6px;
  flex: none;
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.es-btn {
  flex: 1;
  padding: 8px 0;
  border: none;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.06);
  font-family: inherit;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
}

.es-btn:hover {
  background: rgba(15, 23, 42, 0.1);
}

.es-btn.primary {
  background: #3b6ef6;
  color: #fff;
  font-weight: 600;
}

.es-btn.primary:hover {
  background: #2f5fe0;
}

.es-btn.primary:disabled {
  background: rgba(15, 23, 42, 0.07);
  color: #b6c2d2;
  cursor: default;
}

.es-btn.danger {
  flex: 0 0 62px;
  background: transparent;
  color: #dc2626;
}

.es-btn.danger:hover {
  background: rgba(220, 38, 38, 0.1);
}
</style>
