/**
 * 服务端入口
 *
 * 环境变量：
 *   PORT        监听端口（默认 8787）
 *   KUAIBAN_DB  数据库文件路径（默认 ./kuaiban-server.db）
 *   KUAIBAN_ADMIN_PASSWORD  首次启动时管理员的密码；不设则随机生成并打印一次
 *
 * 首次启动会自动建一个管理员账号。**密码只在首次启动时打印一次**，
 * 之后再也不显示 —— 忘了就用 `node src/reset-admin.ts` 重置。
 */

import { randomBytes } from "node:crypto";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { Store } from "./store.ts";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.KUAIBAN_DB ?? "./kuaiban-server.db";

const db = openDatabase(dbPath);
const store = new Store(db);

if (store.listUsers().length === 0) {
  const provided = process.env.KUAIBAN_ADMIN_PASSWORD;
  const password = provided && provided.length >= 8 ? provided : randomBytes(9).toString("base64url");

  store.createUser({
    username: "admin",
    displayName: "管理员",
    password,
    isAdmin: true,
  });

  console.log("─".repeat(60));
  console.log("已创建管理员账号（这段只显示这一次，请立刻记下来）：");
  console.log(`    登录名：admin`);
  console.log(`    密码　：${password}`);
  console.log("    首次登录会要求改密码。");
  console.log("─".repeat(60));
}

const server = createApp({ store });

server.listen(port, () => {
  console.log(`[快办服务端] 已启动：http://127.0.0.1:${port}`);
  console.log(`[快办服务端] 数据库：${dbPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\n[快办服务端] 正在关闭…");
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
