<script setup lang="ts">
/**
 * 设置面板
 *
 * **占满整个面板**，不显示提醒卡片、页签、清单、底部输入框 ——
 * 用户点设置就是要专心改设置，把别的东西堆在旁边只会让人不知道从哪儿看
 * （和编辑待办面板是同一套做法）。
 *
 * 内容自己从各个 store 里取，不靠 App.vue 传一堆 props 进来 ——
 * 这些 store 本来就是模块级单例。
 */

import { computed, ref } from "vue";
import { useAccountStore } from "../store/account";
import { useReminderStore } from "../store/reminders";
import { useSyncStore } from "../store/sync";

const emit = defineEmits<{ (e: "close"): void }>();

const account = useAccountStore();
const sync = useSyncStore();
const reminders = useReminderStore();
const { settings: reminderSettings, inQuietHours } = reminders;

// ── 账号 ──

const loginUser = ref("");
const loginPass = ref("");
const serverDraft = ref(account.serverUrl.value);
const busy = ref(false);
const error = ref<string | null>(null);

/** 同步状态：有话说的时候才显示点，见模板里的说明 */
const syncState = computed(() => {
  const pending = sync.status.value.pendingCount;
  switch (sync.status.value.state) {
    case "syncing":
      return { tone: "syncing", text: "正在同步…" };
    case "error":
      return { tone: "error", text: sync.lastError.value ?? "同步出错" };
    case "synced":
      return pending > 0
        ? { tone: "pending", text: `已连接，还有 ${pending} 条待上传` }
        : { tone: "ok", text: "已同步" };
    default:
      return { tone: "off", text: "未登录 —— 数据只存在这台电脑上" };
  }
});

async function doLogin() {
  if (busy.value || !loginUser.value.trim() || !loginPass.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (await account.login(loginUser.value.trim(), loginPass.value)) {
      loginPass.value = "";
      sync.startSync();
    } else {
      error.value = account.lastError.value ?? "登录失败";
    }
  } finally {
    busy.value = false;
  }
}

async function doLogout() {
  sync.stopSync();
  await account.logout();
  error.value = null;
}

function saveServerUrl() {
  account.setServerUrl(serverDraft.value);
  serverDraft.value = account.serverUrl.value;
  error.value = null;
}
</script>

<template>
  <div class="settings-panel">
    <header class="sp-head">
      <span class="sp-title">设置</span>
      <button class="sp-close" type="button" title="关闭设置" @click="emit('close')">✕</button>
    </header>

    <div class="sp-body">
      <!-- ── 账号与同步 ── -->
      <div class="sp-section">账号与同步</div>

      <div class="sp-status" :class="syncState.tone">
        <span class="sp-dot"></span>
        <span>{{ syncState.text }}</span>
      </div>

      <template v-if="account.loggedIn.value">
        <div class="sp-row">
          <span class="sp-value">
            {{ account.user.value?.displayName }}
            <span class="sp-dim">（{{ account.user.value?.username }}）</span>
          </span>
          <button class="sp-btn" type="button" @click="sync.syncNow()">立即同步</button>
          <button class="sp-btn" type="button" @click="doLogout">退出登录</button>
        </div>
      </template>

      <template v-else>
        <p class="sp-note">
          不登录也能正常用 —— 数据一直存在这台电脑上。登录只是为了在多台设备之间同步。
        </p>
        <input v-model="loginUser" class="sp-input" type="text" placeholder="登录名" />
        <input
          v-model="loginPass"
          class="sp-input"
          type="password"
          placeholder="密码"
          @keydown.enter="doLogin"
        />
        <button class="sp-wide" type="button" :disabled="busy" @click="doLogin">
          {{ busy ? "登录中…" : "登录并开始同步" }}
        </button>
      </template>

      <p v-if="error" class="sp-error">{{ error }}</p>

      <!-- 本地数据属于别的账号：停下来说清楚，绝不硬推 -->
      <div v-if="sync.conflictOwner.value" class="sp-warn">
        <p>
          这台电脑上的待办属于<strong>另一个账号</strong>。直接同步会把上一个人的待办传到当前账号里，
          所以这里停住了。
        </p>
        <button
          class="sp-wide warn"
          type="button"
          @click="sync.adoptLocalDataFor(account.user.value!.id)"
        >把本地待办过户给当前账号</button>
      </div>

      <div class="sp-section">服务器地址</div>
      <div class="sp-row">
        <input v-model="serverDraft" class="sp-input grow" type="text" placeholder="http://…" />
        <button class="sp-btn" type="button" @click="saveServerUrl">保存</button>
      </div>

      <!-- ── 提醒 ── -->
      <div class="sp-section">提醒</div>

      <div class="sp-row">
        <span class="sp-label">提醒声音</span>
        <button class="sp-btn" type="button" @click="reminders.previewChime()">试听</button>
        <button
          class="sp-toggle"
          :class="{ on: reminderSettings.soundEnabled }"
          type="button"
          @click="reminders.setSoundEnabled(!reminderSettings.soundEnabled)"
        >{{ reminderSettings.soundEnabled ? "开" : "关" }}</button>
      </div>

      <div class="sp-row">
        <span class="sp-label">早上汇总没定时间的事</span>
        <button
          class="sp-toggle"
          :class="{ on: reminderSettings.allDaySummaryEnabled }"
          type="button"
          @click="reminders.setAllDaySummaryEnabled(!reminderSettings.allDaySummaryEnabled)"
        >{{ reminderSettings.allDaySummaryEnabled ? "开" : "关" }}</button>
      </div>

      <div class="sp-row">
        <span class="sp-label">免打扰 22:00–07:00</span>
        <button
          class="sp-toggle"
          :class="{ on: reminderSettings.quietHours.enabled }"
          type="button"
          @click="reminders.setQuietEnabled(!reminderSettings.quietHours.enabled)"
        >{{ reminderSettings.quietHours.enabled ? "开" : "关" }}</button>
      </div>

      <p class="sp-note">
        免打扰期间只让图标闪动，不响声音、不自动弹面板 —— 你主动点开仍然能看到。
        当前：{{ inQuietHours ? "免打扰中" : "正常提醒" }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.sp-head {
  display: flex;
  align-items: center;
  flex: none;
  padding: 12px 13px 9px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
}

.sp-title {
  flex: 1;
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}

.sp-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.05);
  font-family: inherit;
  font-size: 13px;
  color: #64748b;
  cursor: pointer;
}

.sp-close:hover {
  background: rgba(15, 23, 42, 0.1);
}

.sp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 13px 16px;
}

/* 分组标题：一眼看出这一块在讲什么 */
.sp-section {
  margin: 16px 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #94a3b8;
}

.sp-section:first-child {
  margin-top: 8px;
}

/* 同步状态条 */
.sp-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(15, 23, 42, 0.04);
  font-size: 12px;
  color: #475569;
}

.sp-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #cbd5e1;
}

.sp-status.ok {
  background: rgba(34, 197, 94, 0.1);
  color: #15803d;
}

.sp-status.ok .sp-dot {
  background: #22c55e;
}

.sp-status.syncing {
  background: rgba(245, 158, 11, 0.12);
  color: #b45309;
}

.sp-status.syncing .sp-dot {
  background: #f59e0b;
  animation: sp-pulse 1s ease-in-out infinite;
}

.sp-status.pending {
  background: rgba(59, 110, 246, 0.1);
  color: #3b6ef6;
}

.sp-status.pending .sp-dot {
  background: #3b6ef6;
}

.sp-status.error {
  background: rgba(220, 38, 38, 0.1);
  color: #b91c1c;
}

.sp-status.error .sp-dot {
  background: #dc2626;
}

@keyframes sp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.sp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.sp-label {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: #334155;
}

.sp-value {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: #1e293b;
  font-weight: 600;
}

.sp-dim {
  color: #94a3b8;
  font-weight: 400;
}

.sp-input {
  width: 100%;
  margin-top: 8px;
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

.sp-input:focus {
  background: rgba(59, 110, 246, 0.08);
  box-shadow: 0 0 0 1.5px rgba(59, 110, 246, 0.28);
}

.sp-input.grow {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}

.sp-note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.65;
  color: #94a3b8;
}

.sp-error {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: #dc2626;
}

.sp-wide {
  width: 100%;
  margin-top: 9px;
  padding: 9px 0;
  border: none;
  border-radius: 8px;
  background: #3b6ef6;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
}

.sp-wide:hover {
  background: #2f5fe0;
}

.sp-wide:disabled {
  background: rgba(15, 23, 42, 0.07);
  color: #b6c2d2;
  cursor: default;
}

.sp-wide.warn {
  background: #ea580c;
}

.sp-btn {
  flex: none;
  padding: 5px 10px;
  border: none;
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.06);
  font-family: inherit;
  font-size: 11.5px;
  color: #475569;
  cursor: pointer;
}

.sp-btn:hover {
  background: rgba(59, 110, 246, 0.12);
  color: #3b6ef6;
}

.sp-toggle {
  flex: none;
  width: 40px;
  padding: 5px 0;
  border: none;
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.06);
  font-family: inherit;
  font-size: 11.5px;
  color: #94a3b8;
  cursor: pointer;
}

.sp-toggle.on {
  background: rgba(59, 110, 246, 0.14);
  color: #3b6ef6;
  font-weight: 600;
}

.sp-warn {
  margin-top: 12px;
  padding: 10px;
  border-radius: 9px;
  background: rgba(234, 88, 12, 0.08);
  font-size: 11.5px;
  line-height: 1.65;
  color: #b45309;
}

.sp-warn p {
  margin: 0;
}
</style>
