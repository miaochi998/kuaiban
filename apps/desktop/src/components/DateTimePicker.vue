<script setup lang="ts">
/**
 * 日期时间选择器 —— 一个面板里同时搞定日期和时间
 *
 * ## 为什么自己写，而不用现成的
 *
 * 1. **原生 `<input type="date">` 的语言控制不了**：它跟系统 locale 走，
 *    实测在快办里显示成 `Oct 2026` / `Su Mo Tu We Th Fr Sa` —— **英文的** ✗
 * 2. **现成的日历库太重**：这个挂件常驻屏幕边上、"速度要快、不要庞大"，
 *    为了一个日历塞进一整套 UI 库不划算。
 * 3. **单月网格 + 时分列本身很简单**，自己写反而更小更快、文案也全是中文。
 *
 * ## 为什么日期和时间合在一个面板
 *
 * 原来编辑待办里有「日期」「时间」两个独立控件，用户得**先点日期、再点时间**，
 * 两步、还容易顾此失彼。合成一个之后，编辑界面里只剩一行 —— 更简洁，
 * 也不用在两个弹层之间来回跳。
 */

import { computed, ref } from "vue";
import {
  addDays,
  fromDateKey,
  toDateKey,
  type DateKey,
  type TimeOfDay,
} from "@kuaiban/core";

const props = defineProps<{
  /** 已排期的日子；`null` = 随笔（不排期） */
  date: DateKey | null;
  /** 时刻；空串 = 全天 */
  time: TimeOfDay | "";
  /** 业务意义上的"今天"，由上层给（业务日边界是 04:00） */
  today: DateKey;
}>();

const emit = defineEmits<{
  /** 确定：把选好的日期与时间交回上层 */
  (e: "picked", value: { date: DateKey | null; time: TimeOfDay | "" }): void;
  (e: "cancel"): void;
}>();

// ── 内部草稿状态：没点"确定"之前不动外面的数据 ──
const draftDate = ref<DateKey | null>(props.date);
const draftTime = ref<TimeOfDay | "">(props.time);
const showTime = ref(false);

/** 当前翻到哪个月（存该月 1 号，便于加减） */
const viewMonth = ref<DateKey>(monthStart(props.date ?? props.today));

function monthStart(key: DateKey): DateKey {
  return `${key.slice(0, 7)}-01` as DateKey;
}

function shiftMonth(delta: number): void {
  const d = fromDateKey(viewMonth.value);
  d.setMonth(d.getMonth() + delta);
  viewMonth.value = toDateKey(d);
}

// ── 日历网格：周一开头（中文习惯，也和界面上的星期选择一致）──
const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

interface Cell {
  key: DateKey;
  day: number;
  /** 属于当前月还是前后补白 */
  inMonth: boolean;
}

const cells = computed<Cell[]>(() => {
  const first = fromDateKey(viewMonth.value);
  // getDay(): 0=周日。转成"周一开头"的偏移量
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);

  const out: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({
      key: toDateKey(d),
      day: d.getDate(),
      inMonth: d.getMonth() === first.getMonth(),
    });
  }
  return out;
});

const monthLabel = computed(() => {
  const d = fromDateKey(viewMonth.value);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
});

const isToday = (key: DateKey) => key === props.today;
const isPicked = (key: DateKey) => key === draftDate.value;

// ── 时间：小时 0–23、分钟 0–59 全都能选 ──
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

const pickedHour = computed(() => (draftTime.value ? Number(draftTime.value.slice(0, 2)) : 9));
const pickedMinute = computed(() => (draftTime.value ? Number(draftTime.value.slice(3, 5)) : 0));

function setTime(hour: number, minute: number): void {
  draftTime.value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` as TimeOfDay;
}

// ── 底部快选 ──
function quick(key: "today" | "tomorrow" | "dayAfter" | "none"): void {
  if (key === "none") {
    // 不排期 = 随笔：既没有日子、也无所谓时刻
    draftDate.value = null;
    draftTime.value = "";
    return;
  }
  const base = props.today;
  const days = key === "today" ? 0 : key === "tomorrow" ? 1 : 2;
  draftDate.value = addDays(base, days);
  viewMonth.value = monthStart(draftDate.value);
}

const quickActive = computed(() => {
  if (draftDate.value === null) return "none";
  if (draftDate.value === props.today) return "today";
  if (draftDate.value === addDays(props.today, 1)) return "tomorrow";
  if (draftDate.value === addDays(props.today, 2)) return "dayAfter";
  return "";
});

/** 顶部那行给人看的摘要 */
const summary = computed(() => {
  if (draftDate.value === null) return "随笔（不排期）";
  const d = fromDateKey(draftDate.value);
  const dayPart = `${d.getMonth() + 1}月${d.getDate()}日`;
  return draftTime.value ? `${dayPart} ${draftTime.value}` : `${dayPart} · 全天`;
});

function confirm(): void {
  emit("picked", { date: draftDate.value, time: draftTime.value });
}
</script>

<template>
  <div class="dtp">
    <div class="dtp-head">
      <span class="dtp-title">选择日期时间</span>
      <span class="dtp-summary">{{ summary }}</span>
    </div>

    <!-- ── 日历（单月，全中文）── -->
    <div v-if="!showTime" class="dtp-cal">
      <div class="dtp-month">
        <button class="dtp-nav" type="button" @click="shiftMonth(-1)">‹</button>
        <span class="dtp-month-label">{{ monthLabel }}</span>
        <button class="dtp-nav" type="button" @click="shiftMonth(1)">›</button>
      </div>

      <div class="dtp-week">
        <span v-for="w in WEEK_LABELS" :key="w">{{ w }}</span>
      </div>

      <div class="dtp-grid">
        <button
          v-for="c in cells"
          :key="c.key"
          class="dtp-day"
          :class="{
            out: !c.inMonth,
            today: isToday(c.key),
            on: isPicked(c.key),
          }"
          type="button"
          @click="draftDate = c.key"
        >{{ c.day }}</button>
      </div>
    </div>

    <!-- ── 时间（点了才展开，不占地方）── -->
    <div v-else class="dtp-time">
      <div class="dtp-time-head">
        <span>{{ draftTime || "全天" }}</span>
        <button class="dtp-chip" type="button" @click="draftTime = ''">设为全天</button>
      </div>

      <div class="dtp-time-cols">
        <div class="dtp-col">
          <div class="dtp-col-label">时</div>
          <div class="dtp-col-scroll">
            <button
              v-for="h in HOURS"
              :key="h"
              class="dtp-num"
              :class="{ on: pickedHour === h }"
              type="button"
              @click="setTime(h, pickedMinute)"
            >{{ String(h).padStart(2, "0") }}</button>
          </div>
        </div>
        <div class="dtp-col">
          <div class="dtp-col-label">分</div>
          <div class="dtp-col-scroll">
            <button
              v-for="m in MINUTES"
              :key="m"
              class="dtp-num"
              :class="{ on: pickedMinute === m }"
              type="button"
              @click="setTime(pickedHour, m)"
            >{{ String(m).padStart(2, "0") }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 快选 + 操作 ── -->
    <div class="dtp-quick">
      <button class="dtp-chip" :class="{ on: quickActive === 'today' }" type="button" @click="quick('today')">今天</button>
      <button class="dtp-chip" :class="{ on: quickActive === 'tomorrow' }" type="button" @click="quick('tomorrow')">明天</button>
      <button class="dtp-chip" :class="{ on: quickActive === 'dayAfter' }" type="button" @click="quick('dayAfter')">后天</button>
      <button class="dtp-chip" :class="{ on: quickActive === 'none' }" type="button" @click="quick('none')">不排期</button>
    </div>

    <div class="dtp-actions">
      <button class="dtp-chip" type="button" @click="showTime ? (showTime = false) : (showTime = true)">
        {{ showTime ? "选择日期" : "选择时间" }}
      </button>
      <span class="dtp-spacer"></span>
      <button class="dtp-chip" type="button" @click="emit('cancel')">取消</button>
      <button class="dtp-ok" type="button" @click="confirm">确定</button>
    </div>
  </div>
</template>

<style scoped>
.dtp {
  border: 1px solid #e3e7ec;
  border-radius: 10px;
  background: #fff;
  padding: 10px;
}

.dtp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.dtp-title {
  font-size: 13px;
  font-weight: 600;
}

.dtp-summary {
  font-size: 12px;
  color: #8b94a1;
}

/* ── 日历 ── */
.dtp-month {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.dtp-month-label {
  font-size: 13px;
  font-weight: 500;
}

.dtp-nav {
  width: 26px;
  height: 26px;
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  background: #fbfcfd;
  font: inherit;
  cursor: pointer;
}

.dtp-nav:hover {
  border-color: #c9d3df;
}

.dtp-week,
.dtp-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.dtp-week span {
  text-align: center;
  font-size: 11px;
  color: #9aa4b2;
  padding-bottom: 2px;
}

.dtp-day {
  aspect-ratio: 1;
  border: none;
  border-radius: 7px;
  background: none;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dtp-day:hover {
  background: #f0f4f9;
}

.dtp-day.out {
  color: #c7ced8;
}

.dtp-day.today {
  font-weight: 700;
  color: #2563eb;
}

.dtp-day.on {
  background: #3b82f6;
  color: #fff;
  font-weight: 600;
}

/* ── 时间 ── */
.dtp-time-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}

.dtp-time-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.dtp-col-label {
  font-size: 11px;
  color: #9aa4b2;
  text-align: center;
  margin-bottom: 4px;
}

.dtp-col-scroll {
  height: 150px;
  overflow-y: auto;
  border: 1px solid #eef1f5;
  border-radius: 8px;
  padding: 2px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dtp-num {
  padding: 5px;
  border: none;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dtp-num:hover {
  background: #f0f4f9;
}

.dtp-num.on {
  background: #3b82f6;
  color: #fff;
  font-weight: 600;
}

/* ── 快选与操作 ── */
.dtp-quick,
.dtp-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.dtp-spacer {
  flex: 1;
}

.dtp-chip {
  padding: 5px 10px;
  border: 1px solid #e3e7ec;
  border-radius: 7px;
  background: #fbfcfd;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dtp-chip:hover {
  border-color: #c9d3df;
}

.dtp-chip.on {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #1d4ed8;
}

.dtp-ok {
  padding: 5px 14px;
  border: none;
  border-radius: 7px;
  background: #3b82f6;
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
</style>
