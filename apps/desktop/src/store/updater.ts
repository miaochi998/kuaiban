/**
 * 在线更新
 *
 * ## 为什么要自己做提示，而不是弹系统对话框
 *
 * 挂件是个"贴在屏幕边上的小东西"，弹一个模态对话框会打断用户手头的事。
 * 而且用户可能正在别的全屏应用里。所以策略是：
 *
 * - **后台悄悄检查、悄悄下载**（不打扰）
 * - 下载好了之后，在设置面板里显示一行「已就绪，重启生效」
 * - **重启这个动作必须用户点**，绝不自动重启 —— 应用重启是有存在感的事
 *
 * ## 签名
 *
 * 更新包用 minisign 私钥签名，公钥烧在客户端里（tauri.conf.json 的 plugins.updater.pubkey）。
 * 验签不过的包一律不装 —— 否则"能往这个地址放文件的人"就能给所有人推任意程序。
 * **私钥丢了就再也发不了更新**，必须单独备份。
 */

import { computed, ref } from "vue";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * 检查更新的间隔（6 小时）。
 *
 * 太频繁没必要：内部工具一天发不了一次版；而且每次检查都是一次网络请求。
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 启动后等一会儿再查 —— 别和"打开软件就开始拉待办"抢资源 */
const STARTUP_DELAY_MS = 15_000;

const LAST_CHECK_KEY = "kuaiban.update.lastCheck.v1";

export type UpdatePhase =
  | "idle" // 还没查过
  | "checking"
  | "latest" // 已是最新
  | "available" // 有新版本，等着下载
  | "downloading"
  | "ready" // 下载安装完成，等用户重启
  | "error";

const phase = ref<UpdatePhase>("idle");
const currentVersion = ref("");
const newVersion = ref<string | null>(null);
const progress = ref(0);
const error = ref<string | null>(null);

/** 挂起的 Update 对象，下载时要用 */
let pending: Update | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let autoTimer: ReturnType<typeof setInterval> | null = null;

const hasUpdate = computed(() => phase.value === "available" || phase.value === "downloading");
/** 该不该在界面上冒个泡（没事的时候一个字都不显示） */
const noteworthy = computed(
  () => phase.value === "ready" || phase.value === "available" || phase.value === "error",
);

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // 打包成安装包之前（开发模式）根本没法自更新，这时给一句人话而不是一串英文
  if (/not available|not supported|unknown command|plugin/i.test(text)) {
    return "开发模式下不支持自动更新（要装成正式安装包才有）";
  }
  if (/network|fetch|dns|timeout|connect/i.test(text)) return "连不上更新服务器";
  return text;
}

function loadLastCheck(): number {
  try {
    return Number(globalThis.localStorage?.getItem(LAST_CHECK_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function saveLastCheck(): void {
  try {
    globalThis.localStorage?.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* 记不住就下次再查，无妨 */
  }
}

/** 查一下有没有新版本。用户手动点时会强制查（忽略间隔） */
export async function checkForUpdate(force = false): Promise<void> {
  if (phase.value === "checking" || phase.value === "downloading") return;
  if (!force && Date.now() - loadLastCheck() < CHECK_INTERVAL_MS && phase.value !== "idle") return;

  phase.value = "checking";
  error.value = null;

  try {
    const found = await check();
    saveLastCheck();

    if (!found) {
      phase.value = "latest";
      newVersion.value = null;
      pending = null;
      return;
    }

    pending = found;
    newVersion.value = found.version;
    phase.value = "available";

    // 有新版本就**直接开始下载**：用户不用等，等他看到提示时包已经躺好了
    void downloadUpdate();
  } catch (err) {
    phase.value = "error";
    error.value = describe(err);
  }
}

async function downloadUpdate(): Promise<void> {
  if (!pending) return;
  phase.value = "downloading";
  progress.value = 0;

  try {
    let total = 0;
    let got = 0;

    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        got += event.data.chunkLength;
        // 拿不到总长度时进度条没意义，显示成"下载中"就行
        progress.value = total > 0 ? Math.min(1, got / total) : -1;
      }
    });

    phase.value = "ready";
    progress.value = 1;
  } catch (err) {
    phase.value = "error";
    error.value = describe(err);
  }
}

/** 重启并应用新版本。**只有用户点了才会发生** */
export async function restartToUpdate(): Promise<void> {
  try {
    await relaunch();
  } catch (err) {
    phase.value = "error";
    error.value = describe(err);
  }
}

/** 启动后台检查：隔一段时间查一次，别打扰用户 */
export function startUpdater(): void {
  // 先把当前版本号读出来（读不到就算了，不影响更新）
  void (async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      currentVersion.value = await getVersion();
    } catch {
      /* 浏览器里没有 Tauri，忽略 */
    }
  })();

  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      void checkForUpdate();
    }, STARTUP_DELAY_MS);
  }
  if (autoTimer === null) {
    autoTimer = setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
  }
}

export function useUpdaterStore() {
  return {
    phase,
    currentVersion,
    newVersion,
    progress,
    error,
    hasUpdate,
    noteworthy,
    checkForUpdate,
    restartToUpdate,
  };
}
