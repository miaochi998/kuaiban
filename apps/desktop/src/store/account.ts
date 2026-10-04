/**
 * 账号与登录
 *
 * ## 为什么登录是**可选**的
 *
 * 这个软件的铁律是「离线优先、本地永远可用」。所以没登录时它就是一个纯粹的单机待办，
 * 一切照常；登录之后才开始同步。**绝不能做成"不登录就没法用"** ——
 * 服务器连不上、公司网络出问题、服务器还没部署，都不该让人记不了事。
 *
 * ## 令牌存哪儿
 *
 * 存在 webview 的 localStorage 里。30 天有效，服务端只存哈希。
 * 没有用系统钥匙串：那需要额外的平台代码，而这里存的是一个可随时吊销的令牌，
 * 不是密码本身 —— 风险可控，复杂度省下来。
 */

import { computed, ref } from "vue";
import type { AuthUser } from "@kuaiban/core";

const STORAGE_KEY = "kuaiban.account.v1";

/**
 * 服务器地址：**构建时就烧进安装包里，用户不需要知道、也没法填**。
 *
 * 值来自 `lib/endpoints.ts` —— 那里是正式域名的唯一一处定义。
 * 一开始我把它做成了设置里的输入框，用户一看就反问
 * "难道还需要用户自己填服务器地址吗？"。确实不该：
 * 这是公司内部工具，服务器在哪儿是管理员部署时决定的事。
 */
import { SERVER_URL } from "../lib/endpoints";

export { SERVER_URL };

interface StoredAccount {
  token: string;
  user: AuthUser;
}

const token = ref<string | null>(null);
const user = ref<AuthUser | null>(null);
const busy = ref(false);
const lastError = ref<string | null>(null);

const loggedIn = computed(() => token.value !== null && user.value !== null);

/**
 * 是否必须先改密码。
 *
 * 服务端一直在登录响应里标这个字段，**但客户端从来没看过它** ——
 * 于是管理员给的初始密码可以一直用下去，而初始密码是经聊天/文档传出去的，
 * 那个"首次登录强制改密"的保护等于没有。现在由界面硬挡。
 */
const mustChangePassword = computed(() => user.value?.mustChangePassword === true);

// ─────────────────────────────────────────────────────────────
// 本地持久化
// ─────────────────────────────────────────────────────────────

export function loadAccount(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<StoredAccount>;
    if (typeof parsed.token === "string" && parsed.token) token.value = parsed.token;
    if (parsed.user && typeof parsed.user === "object") user.value = parsed.user as AuthUser;
  } catch {
    // 存的东西坏了就当没登录过 —— 用户重新登一次即可，不能因此起不来
  }
}

function persist(): void {
  try {
    if (!token.value || !user.value) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: token.value, user: user.value }),
    );
  } catch {
    /* 存不下就下次重新登录，不影响使用 */
  }
}

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 带登录态的请求。
 *
 * `tokenOverride` 用在登录那一刻 —— 那时还没有令牌可用。
 */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  // 网络不通时不能让界面一直转圈：给它一个上限
  const timer = globalThis.setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token.value) headers.authorization = `Bearer ${token.value}`;

    const response = await fetch(`${SERVER_URL}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers,
      signal: controller.signal,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });

    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : `请求失败（${response.status}）`;

      // 令牌失效：自动清掉登录态，界面会退回"未登录"
      if (response.status === 401 && token.value) {
        clearSession();
      }
      throw new ApiError(response.status, message);
    }

    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(0, "连不上服务器（超时）");
    }
    throw new ApiError(0, "连不上服务器");
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function clearSession(): void {
  token.value = null;
  user.value = null;
  persist();
}

// ─────────────────────────────────────────────────────────────
// 动作
// ─────────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<boolean> {
  busy.value = true;
  lastError.value = null;
  try {
    const result = await apiFetch<{ token: string; user: AuthUser }>("/api/login", {
      body: { username, password },
    });
    token.value = result.token;
    user.value = result.user;
    persist();
    return true;
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : "登录失败";
    return false;
  } finally {
    busy.value = false;
  }
}

export async function logout(): Promise<void> {
  try {
    if (token.value) await apiFetch("/api/logout", { body: {} });
  } catch {
    // 服务器联系不上也要让本地退出登录 —— 用户要的是"退出"，不是"退出成功"
  }
  clearSession();
  // 通知同步层复位（动态引入避免模块循环依赖）
  void import("./sync").then((m) => m.stopSync());
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  busy.value = true;
  lastError.value = null;
  try {
    const result = await apiFetch<{ token: string; user: AuthUser }>("/api/password", {
      body: { oldPassword, newPassword },
    });
    // 改密码会作废所有令牌，服务端同时发了一个新的，立刻换上
    token.value = result.token;
    user.value = result.user;
    persist();
    return true;
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : "改密码失败";
    return false;
  } finally {
    busy.value = false;
  }
}

export function useAccountStore() {
  return {
    serverUrl: SERVER_URL,
    user,
    token,
    busy,
    lastError,
    loggedIn,
    mustChangePassword,
    login,
    logout,
    changePassword,
  };
}

// 模块加载时就把上次的登录态读回来，避免首屏闪一下"未登录"
loadAccount();
