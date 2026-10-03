<script setup lang="ts">
import { computed } from "vue";
import { describeRepeat, isOccurrenceDone, type DateKey, type Todo } from "@kuaiban/core";

const props = defineProps<{
  todo: Todo;
  /** 勾选/跳过要带上"哪一天"，重复任务的完成是按天的 */
  dateKey: DateKey;
  /** 逾期天数（0 = 不逾期） */
  overdueDays?: number;
  /** 是否拖到需要提醒的程度 */
  needsAttention?: boolean;
  /** 刚添加的那一条 —— 闪一下，让用户确信这次操作生效了 */
  highlight?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle"): void;
  (e: "remove"): void;
  (e: "carry-over"): void;
}>();

const done = computed(() => isOccurrenceDone(props.todo, props.dateKey));
const isOverdue = computed(() => (props.overdueDays ?? 0) > 0);

/**
 * 能不能"一键挪到某天"。
 * - 逾期的一次性待办 → 搬到今天
 * - 随笔里没排期的（date 为 null）→ 排到今天
 * 后者本来只能看不能动，记进随笔的东西就"烂"在那儿了。
 */
const canCarry = computed(() => isOverdue.value || props.todo.date === null);
const carryLabel = computed(() => (props.todo.date === null ? "排今天" : "搬今天"));
const repeatLabel = computed(() =>
  props.todo.repeat.kind === "none" ? "" : describeRepeat(props.todo.repeat),
);
</script>

<template>
  <div class="row" :class="{ done, overdue: isOverdue, flash: highlight }">
    <button
      class="check"
      :class="{ on: done }"
      type="button"
      :aria-label="done ? '标记未完成' : '标记完成'"
      @click="emit('toggle')"
    ></button>

    <div class="body">
      <div class="title">{{ todo.title }}</div>
      <div class="meta">
        <span v-if="todo.time" class="time">{{ todo.time }}</span>
        <span v-if="repeatLabel" class="repeat">🔁 {{ repeatLabel }}</span>
        <span
          v-if="isOverdue"
          class="delay"
          :class="{ hot: needsAttention }"
        >拖了 {{ overdueDays }} 天</span>
      </div>
    </div>

    <div class="actions">
      <button
        v-if="canCarry"
        class="act"
        type="button"
        :title="carryLabel"
        @click="emit('carry-over')"
      >{{ carryLabel }}</button>
      <button class="act danger" type="button" title="删除" @click="emit('remove')">删</button>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 9px;
  transition: background 0.12s;
}

.row:hover {
  background: rgba(15, 23, 42, 0.04);
}

/* 刚添加的那条闪一下。
   只靠"清单里多了一行"太容易被忽略 —— 尤其是清单很长、
   或者新条目落在折叠区/可视区之外的时候。 */
.row.flash {
  animation: row-flash 1.4s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@keyframes row-flash {
  0% {
    background: rgba(59, 110, 246, 0.26);
  }
  55% {
    background: rgba(59, 110, 246, 0.14);
  }
  100% {
    background: transparent;
  }
}

/* ── 勾选框 ── */
.check {
  position: relative;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  flex: none;
  padding: 0;
  border: 1.5px solid #cbd5e1;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.13s, background 0.13s;
}

.check:hover {
  border-color: #3b6ef6;
}

.check.on {
  background: #3b6ef6;
  border-color: #3b6ef6;
}

.check.on::after {
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

/* ── 内容 ── */
.body {
  flex: 1;
  min-width: 0;
}

.title {
  font-size: 13px;
  line-height: 1.36;
  color: #1e293b;
  word-break: break-word;
}

.row.done .title {
  color: #cbd5e1;
  text-decoration: line-through;
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 2px;
  font-size: 10px;
  color: #94a3b8;
}

.meta:empty {
  display: none;
}

.time {
  color: #3b6ef6;
  font-weight: 600;
}

.delay {
  color: #f59e0b;
  font-weight: 600;
}

.delay.hot {
  color: #dc2626;
}

/* ── 悬停才出现的操作 ──
   平时藏起来，避免面板里到处是按钮显得吵；
   挂件本来就小，视觉噪音的代价很高。 */
.actions {
  display: flex;
  gap: 3px;
  flex: none;
  opacity: 0;
  transition: opacity 0.13s;
}

.row:hover .actions,
.row:focus-within .actions {
  opacity: 1;
}

.act {
  padding: 2px 6px;
  border: none;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.06);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.6;
  color: #64748b;
  cursor: pointer;
  white-space: nowrap;
}

.act:hover {
  background: rgba(59, 110, 246, 0.12);
  color: #3b6ef6;
}

.act.danger:hover {
  background: rgba(220, 38, 38, 0.1);
  color: #dc2626;
}
</style>
