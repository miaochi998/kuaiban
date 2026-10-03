/**
 * 服务端入口
 *
 * 环境变量：
 *   PORT        监听端口（默认 8787）
 *   KUAIBAN_DB  数据库文件路径（默认 ./kuaiban-server.db）
 *   KUAIBAN_ADMIN_PASSWORD  首次启动时管理员的密码；不设则随机生成并打印一次
 *   KUAIBAN_PUBLIC_ORIGIN   对外域名（默认 https://kuaiban.bonnei.com）。
 *                           下载地址与更新地址都从它拼出来，换域名不用重新发版。
 *   KUAIBAN_RELEASES_DIR    发布目录（默认 <数据库同级>/releases）
 *   KUAIBAN_GITHUB_REPO     客户端 Release 所在仓库（owner/repo）。
 *                           设了它，下载页与更新清单就**自动跟随 GitHub Release**
 *                           —— 发版只需要打个 tag，没人要手动传文件。
 *   KUAIBAN_GITHUB_TOKEN    仓库若是私有的，给一个只读 token
 *
 * 首次启动会自动建一个管理员账号。**密码只在首次启动时打印一次**，
 * 之后再也不显示 —— 忘了就用 `node src/reset-admin.ts` 重置。
 */

import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { ReleaseStore } from "./releases.ts";
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

// 发布目录：默认跟数据库放一起（一次备份全都带走）
const releasesDir =
  process.env.KUAIBAN_RELEASES_DIR ?? join(dirname(dbPath), "releases");

const releases = new ReleaseStore({
  dir: releasesDir,
  // 对外域名。**只有这一处** —— 下载页、更新清单都从这里拼
  origin: process.env.KUAIBAN_PUBLIC_ORIGIN ?? "https://kuaiban.bonnei.com",
  // 设了它，客户端版本就自动跟随 GitHub Release（发版只需打 tag）
  ...(process.env.KUAIBAN_GITHUB_REPO ? { githubRepo: process.env.KUAIBAN_GITHUB_REPO } : {}),
  ...(process.env.KUAIBAN_GITHUB_TOKEN ? { githubToken: process.env.KUAIBAN_GITHUB_TOKEN } : {}),
});

const server = createApp({ store, releases });

server.listen(port, () => {
  console.log(`[快办服务端] 已启动：http://127.0.0.1:${port}`);
  console.log(`[快办服务端] 数据库：${dbPath}`);
  console.log(`[快办服务端] 发布目录：${releases.dir}`);
  console.log(`[快办服务端] 对外域名：${releases.origin}`);
  console.log(
    process.env.KUAIBAN_GITHUB_REPO
      ? `[快办服务端] 客户端版本跟随 GitHub Release：${process.env.KUAIBAN_GITHUB_REPO}`
      : "[快办服务端] 未配置 KUAIBAN_GITHUB_REPO —— 下载页读本地清单",
  );
  console.log(`[快办服务端] 下载页：${releases.origin}/  ·  管理后台：${releases.origin}/admin`);
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
