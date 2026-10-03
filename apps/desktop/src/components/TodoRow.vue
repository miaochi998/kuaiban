<script setup lang="ts">
import { computed } from "vue";
import { describeRepeat, isOccurrenceDone, type DateKey, type Todo } from "@kuaiban/core";

const props = defineProps<{
  todo: Todo;
  /** 勾选/跳过要带上"哪一天"，重复任务的完成是按天的 */
  dateKey: DateKey;
  /** 当前业务日 —— 用来判断"这是不是以后的事" */
  businessDate: DateKey;
  /** 逾期天数（0 = 不逾期） */
  overdueDays?: number;
  /** 是否拖到需要提醒的程度 */
  needsAttention?: boolean;
  /** 刚添加的那一条 —— 闪一下，让用户确信操作生效了 */
  highlight?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle"): void;
  (e: "remove"): void;
  (e: "carry-over"): void;
  (e: "edit"): void;
}>();

/**
 * 随笔（未排期）不是待办，**没有"完成"这个概念**。
 *
 * 它就是个记事本，用来记想法和灵感 —— "我把这条灵感完成了"没有意义。
 * 只有排上日期之后它才变成待办，那时才能勾完成。
 * （这条规则在大脑的 `TodoService.setDone` 里也守了一遍，各端都跑不掉。）
 */
const isNote = computed(() => props.todo.date === null);

const done = computed(() => !isNote.value && isOccurrenceDone(props.todo, props.dateKey));
const isOverdue = computed(() => (props.overdueDays ?? 0) > 0);

/**
 * 是不是"排在未来"的事。
 *
 * 完成的含义是**"我今天把它做掉了"**。把明天（或更远）的事直接勾掉，
 * "完成时间"和"计划日期"就打架了 —— 而真实动作其实是"我提前做了"，
 * 对应的操作应该是**先搬到今天、再完成**。所以未来的事不给"完成"按钮。
 */
const isFuture = computed(
  () => props.todo.date !== null && props.todo.date > props.businessDate,
);

const canComplete = computed(() => !isNote.value && !isFuture.value);

/**
 * 能不能"一键挪到某天"：
 * - 逾期的一次性待办 → 搬今天
 * - 随笔里没排期的 → 排今天（排上日期就变成待办了）
 * - **未来排期的事** → 搬到今天（提前做）
 */
const canCarry = computed(() => isOverdue.value || isNote.value || isFuture.value);

const carryLabel = computed(() => {
  if (isOverdue.value) return "搬今天";
  if (isNote.value) return "排今天";
  return "搬到今天";
});

const doneLabel = computed(() => (done.value ? "撤销" : "完成"));

const repeatLabel = computed(() =>
  props.todo.repeat.kind === "none" ? "" : describeRepeat(props.todo.repeat),
);
</script>

<template>
  <div class="row" :class="{ done, overdue: isOverdue, future: isFuture, noteref: isNote, flash: highlight }">
    <!-- 点内容区打开编辑面板：改内容 / 日期 / 时间 / 重复规则 -->
    <div
      class="body"
      role="button"
      tabindex="0"
      title="点击修改内容、时间、重复规则"
      @click="emit('edit')"
      @keydown.enter="emit('edit')"
    >
      <div class="title">{{ todo.title }}</div>
      <div class="meta">
        <span v-if="todo.time" class="time">{{ todo.time }}</span>
        <span v-if="repeatLabel" class="repeat">🔁 {{ repeatLabel }}</span>
        <span v-if="isFuture" class="future-tag">以后的事</span>
        <span v-if="isOverdue" class="delay" :class="{ hot: needsAttention }">
          拖了 {{ overdueDays }} 天
        </span>
      </div>
    </div>

    <!--
      操作按钮和「删」一样，**鼠标悬停才出现**。
      曾经用一个圆形勾选框表示完成，但那个符号要猜（用户反馈"为什么是复选框"）；
      直接写「完成」两个字，不用解释。
      平时藏起来是因为挂件小、视觉噪音代价高 —— 按钮占位但不显示，行不会跳动。
    -->
    <div class="actions">
      <button
        v-if="canComplete"
        class="act primary"
        :class="{ undo: done }"
        type="button"
        :title="done ? '撤销完成' : '标记完成'"
        @click="emit('toggle')"
      >{{ doneLabel }}</button>
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

/* ── 内容 ── */
.body {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  border-radius: 6px;
}

.body:focus-visible {
  outline: 2px solid rgba(59, 110, 246, 0.5);
  outline-offset: 1px;
}

.title {
  font-size: 13px;
  line-height: 1.36;
  color: #1e293b;
  word-break: break-word;
}

/* 随笔：不是待办，所以不用"待办"的视觉语言 */
.row.noteref .title {
  color: #475569;
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

.future-tag {
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(59, 110, 246, 0.1);
  color: #6b8fd8;
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
  gap: 4px;
  flex: none;
  opacity: 0;
  /* 藏起来的时候必须同时禁用点击 —— 否则会点到一个看不见的按钮上 */
  pointer-events: none;
  transition: opacity 0.13s;
}

.row:hover .actions,
.row:focus-within .actions {
  opacity: 1;
  pointer-events: auto;
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

/* 「完成」是这里最常用的动作，给它一点分量，别和「删」长得一样 */
.act.primary {
  background: rgba(59, 110, 246, 0.12);
  color: #3b6ef6;
  font-weight: 600;
}

.act.primary:hover {
  background: #3b6ef6;
  color: #fff;
}

/* 已完成的行里它是「撤销」，语气要弱下来 */
.act.primary.undo {
  background: rgba(15, 23, 42, 0.06);
  color: #94a3b8;
  font-weight: 400;
}

.act.primary.undo:hover {
  background: rgba(15, 23, 42, 0.12);
  color: #475569;
}
</style>
