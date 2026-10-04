<script setup lang="ts">
/**
 * 首次登录必须改密码 —— 不改完不能用。
 *
 * ## 为什么必须挡住
 *
 * 管理员给的是**初始密码**，它经由聊天/文档传给使用者，中间环节多。
 * 服务端本来就在登录响应里标了 `mustChangePassword`，但**客户端一直没理会它**，
 * 于是"先用初始密码进去、改不改随意" —— 那个保护等于没有。
 *
 * 所以这里不是"温馨提示"，是**硬挡**：改完之前整个面板都被它盖住。
 *
 * ## 文案上的两个注意
 *
 * - 不用"密码过于简单"这类指责性说法，用户没做错什么
 * - 明确说清**为什么**要改（初始密码是别人给你的），用户才愿意配合
 */

import { computed, ref } from "vue";
import { useAccountStore } from "../store/account";

const account = useAccountStore();

const oldPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const localError = ref<string | null>(null);

const tooShort = computed(() => newPassword.value.length > 0 && newPassword.value.length < 8);
const mismatch = computed(
  () => confirmPassword.value.length > 0 && newPassword.value !== confirmPassword.value,
);
const canSubmit = computed(
  () =>
    oldPassword.value.length > 0 &&
    newPassword.value.length >= 8 &&
    newPassword.value === confirmPassword.value &&
    !account.busy.value,
);

async function submit() {
  localError.value = null;
  if (!canSubmit.value) return;

  const ok = await account.changePassword(oldPassword.value, newPassword.value);
  if (!ok) {
    localError.value = account.lastError.value ?? "改密码失败";
    return;
  }
  // 成功后服务端会把 mustChangePassword 置回 false，这个界面自己就消失了
}
</script>

<template>
  <div class="fp">
    <div class="fp-title">先改一下密码</div>
    <p class="fp-why">
      管理员给你的这个密码是<strong>初始密码</strong>，改完才能开始用。
    </p>

    <label class="fp-label">当前密码（管理员给你的那个）</label>
    <input
      v-model="oldPassword"
      class="fp-input"
      type="password"
      autocomplete="current-password"
      placeholder="初始密码"
    />

    <label class="fp-label">新密码</label>
    <input
      v-model="newPassword"
      class="fp-input"
      type="password"
      autocomplete="new-password"
      placeholder="至少 8 位"
    />
    <p v-if="tooShort" class="fp-hint">还差 {{ 8 - newPassword.length }} 位</p>

    <label class="fp-label">再输一遍新密码</label>
    <input
      v-model="confirmPassword"
      class="fp-input"
      type="password"
      autocomplete="new-password"
      placeholder="两次要一样"
      @keyup.enter="submit"
    />
    <p v-if="mismatch" class="fp-hint">两次输入不一样</p>

    <p v-if="localError" class="fp-error">{{ localError }}</p>

    <button class="fp-btn" type="button" :disabled="!canSubmit" @click="submit">
      {{ account.busy.value ? "正在改…" : "改好，开始用" }}
    </button>

    <button class="fp-out" type="button" @click="account.logout()">退出登录</button>
  </div>
</template>

<style scoped>
.fp {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 16px;
  background: #fff;
  overflow-y: auto;
}

.fp-title {
  font-size: 17px;
  font-weight: 600;
}

.fp-why {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
  color: #6b7480;
}

.fp-label {
  margin-top: 8px;
  font-size: 12px;
  color: #8b94a1;
}

.fp-input {
  padding: 9px 11px;
  border: 1px solid #e3e7ec;
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  background: #fbfcfd;
}

.fp-input:focus {
  outline: none;
  border-color: #3b82f6;
  background: #fff;
}

.fp-hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: #d97706;
}

.fp-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: #dc2626;
}

.fp-btn {
  margin-top: 14px;
  padding: 10px;
  border: none;
  border-radius: 9px;
  background: #3b82f6;
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.fp-btn:disabled {
  background: #c9d3df;
  cursor: default;
}

.fp-out {
  margin-top: 6px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: #8b94a1;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.fp-out:hover {
  color: #4b5563;
}
</style>
