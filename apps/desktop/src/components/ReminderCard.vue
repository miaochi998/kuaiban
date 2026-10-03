<script setup lang="ts">
import type { QueuedReminder } from "../lib/reminder-queue";

defineProps<{
  items: QueuedReminder[];
  /** 其中有多少条是"错过太久"的 */
  missedCount: number;
}>();

const emit = defineEmits<{
  (e: "complete", item: QueuedReminder): void;
  (e: "snooze", item: QueuedReminder): void;
  (e: "mute", item: QueuedReminder): void;
  (e: "snooze-all"): void;
  (e: "mute-all"): void;
}>();

/** 到点时刻。有一条没有具体时间是不可能的（全天事项不产生提醒），所以直接取。 */
function fireLabel(item: QueuedReminder): string {
  return item.todo.time ?? "";
}
</script>

<template>
  <!--
    提醒卡片。
    **它天然就是"提醒风暴合并"**：10 件事同时到点也只出现这一张卡，
    绝不会弹 10 个窗口 —— 那是用户第一天就会卸载软件的原因。
  -->
  <section class="reminder-card" role="alert">
    <header class="rc-head">
      <span class="rc-title">⏰ 到点了<span class="rc-count">{{ items.length }}</span></span>
      <button class="rc-link" type="button" title="今天不再提醒这些" @click="emit('mute-all')">
        今天不再提醒
      </button>
    </header>

    <p v-if="missedCount > 0" class="rc-missed">
      其中 {{ missedCount }} 条是我不在的时候错过的
    </p>

    <ul class="rc-list">
      <li v-for="item in items" :key="item.key" class="rc-item">
        <!-- 和待办行保持一致：直接写「完成」，不用需要猜的圆圈符号 -->
        <button
          class="rc-done"
          type="button"
          title="标记完成"
          @click="emit('complete', item)"
        >完成</button>

        <div class="rc-body">
          <div class="rc-text">{{ item.todo.title }}</div>
          <div class="rc-meta">
            <span class="rc-time">{{ fireLabel(item) }}</span>
            <span v-if="item.missed" class="rc-tag">错过</span>
          </div>
        </div>

        <button
          class="rc-act"
          type="button"
          title="10 分钟后再提醒"
          @click="emit('snooze', item)"
        >推后</button>
        <button
          class="rc-act ghost"
          type="button"
          title="今天不再提醒这一条"
          @click="emit('mute', item)"
        >静音</button>
      </li>
    </ul>

    <footer v-if="items.length > 1" class="rc-foot">
      <button class="rc-all" type="button" @click="emit('snooze-all')">全部推后 10 分钟</button>
    </footer>
  </section>
</template>

<style scoped>
.reminder-card {
  flex: none;
  margin: 0 8px 8px;
  padding: 9px 10px 8px;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(255, 237, 213, 0.95), rgba(255, 247, 237, 0.95));
  border: 1px solid rgba(234, 88, 12, 0.22);
  max-height: 240px;
  overflow-y: auto;
}

.rc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.rc-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 700;
  color: #c2410c;
}

.rc-count {
  padding: 0 5px;
  border-radius: 6px;
  background: rgba(234, 88, 12, 0.16);
  font-size: 10px;
}

.rc-link {
  margin-left: auto;
  padding: 1px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 10px;
  color: #b45309;
  cursor: pointer;
}

.rc-link:hover {
  background: rgba(234, 88, 12, 0.12);
}

.rc-missed {
  margin: 0 0 5px;
  font-size: 10px;
  line-height: 1.5;
  color: #92400e;
}

.rc-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.rc-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
}

.rc-done {
  flex: none;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(234, 88, 12, 0.16);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  color: #c2410c;
  cursor: pointer;
  white-space: nowrap;
}

.rc-done:hover {
  background: #ea580c;
  color: #fff;
}

.rc-body {
  flex: 1;
  min-width: 0;
}

.rc-text {
  font-size: 12.5px;
  line-height: 1.35;
  color: #7c2d12;
  word-break: break-word;
}

.rc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
  font-size: 10px;
  color: #c2410c;
}

.rc-time {
  font-weight: 700;
}

.rc-tag {
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(220, 38, 38, 0.12);
  color: #b91c1c;
}

.rc-act {
  flex: none;
  padding: 2px 7px;
  border: none;
  border-radius: 6px;
  background: rgba(234, 88, 12, 0.14);
  font-family: inherit;
  font-size: 10px;
  color: #c2410c;
  cursor: pointer;
  white-space: nowrap;
}

.rc-act:hover {
  background: rgba(234, 88, 12, 0.24);
}

.rc-act.ghost {
  background: transparent;
  color: #b45309;
}

.rc-act.ghost:hover {
  background: rgba(234, 88, 12, 0.12);
}

.rc-foot {
  margin-top: 5px;
}

.rc-all {
  width: 100%;
  padding: 4px 0;
  border: none;
  border-radius: 7px;
  background: rgba(234, 88, 12, 0.14);
  font-family: inherit;
  font-size: 11px;
  color: #c2410c;
  cursor: pointer;
}

.rc-all:hover {
  background: rgba(234, 88, 12, 0.24);
}
</style>
