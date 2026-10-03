import { createApp } from "vue";
import App from "./App.vue";
import { createTodoRepository } from "./data";
import { initTodoStore, reportFatal, reportPhase, reportStorageWarning } from "./store/todos";

// 先挂载界面（让挂件外壳立刻出现），再去初始化存储。
// 存储初始化可能要等几百毫秒，不能因此让用户看到一片空白。
const app = createApp(App);

/**
 * 全局错误处理。
 *
 * 之前渲染期间的异常只会进 console —— 界面上表现为"停在原地不动"，
 * 用户和排查者都看不到任何线索。一次真实故障（永远停在"正在读取…"）
 * 找根因花了很久，就是因为这层缺失。
 */
app.config.errorHandler = (err, _instance, info) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[快办] 界面出错", err, info);
  reportFatal(`界面出错（${info}）：${message}`);
};

app.mount("#app");

/**
 * 启动流程。
 *
 * ⚠️ 这里的 catch 必须把错误送到界面上。
 * 之前它只写了 console.error —— 结果"数据库打不开"这种事在界面上完全看不出来，
 * 表现就是永远停在"正在读取…"，而用户刚记下的东西一条都看不到。
 * 一次真实反馈（"添加了但界面上看不到、也没有任何提示"）就是这么来的。
 */
void (async () => {
  try {
    reportPhase("正在打开本地数据库…");
    const { repo, kind, reason } = await createTodoRepository();
    reportPhase(kind === "sqlite" ? "数据库已打开，正在读取…" : "已退化为内存存储，正在读取…");
    if (kind === "memory") {
      reportStorageWarning(
        `本地数据库打不开，已临时改用内存存储 —— 这次记的东西关掉软件就会丢。原因：${reason ?? "未知"}`,
      );
    }
    await initTodoStore(repo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[快办] 初始化失败", err);
    reportPhase("初始化失败");
    reportFatal(`初始化失败：${message}`);
  }
})();
