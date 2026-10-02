import { createApp } from "vue";
import App from "./App.vue";
import { createTodoRepository } from "./data";
import { initTodoStore } from "./store/todos";

// 先挂载界面（让挂件外壳立刻出现），再去初始化存储。
// 存储初始化可能要等几百毫秒，不能因此让用户看到一片空白。
createApp(App).mount("#app");

void (async () => {
  try {
    const repo = await createTodoRepository();
    await initTodoStore(repo);
  } catch (err) {
    console.error("[快办] 初始化失败", err);
  }
})();
