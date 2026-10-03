import { defineConfig } from "@playwright/test";

/**
 * 浏览器自动化配置
 *
 * 用途：在没有 Tauri 外壳的普通浏览器里跑界面逻辑（新增 / 勾选 / 删除 / 页签切换）。
 * 存储会自动退化成内存实现（见 src/data/index.ts），所以每次打开都是干净的空清单，
 * 测试之间天然隔离、可重复。
 *
 * 它**测不到**的：贴边挂件、悬停展开、不抢焦点、SQLite —— 那些是 Tauri 专属，
 * 由 apps/desktop/src-tauri 的代码 + Windows 真机验证负责。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    // 面板实际是 340×560，用相近的视口，布局与真实挂件一致
    viewport: { width: 360, height: 640 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @kuaiban/desktop dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
