/**
 * 把架构写进 macOS 更新包的文件名（CI 用）
 *
 * Tauri 打出来的更新包叫 `KuaiBan.app.tar.gz`，**文件名里没有架构信息**
 * （架构只在目录名 `target/<arch>/release/...` 上，一传到 GitHub Release 就丢了）。
 * 服务端要靠文件名区分芯片，分不清就只能不发 ——
 * 而"把 Apple 芯片的包装到 Intel 机器上"会让用户直接打不开。
 *
 * 同样刻意用独立文件而不是内联 shell：原来写的
 * `[ -z "$arch" ] && arch="x64"` 在 arch **非空**时返回 1，
 * 被 GitHub Actions 默认的 `set -e` 直接终止脚本（真踩过）。
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.app\.tar\.gz(\.sig)?$/.test(entry.name)) hits.push(full);
  }
}

const root = "apps/desktop/src-tauri/target";
if (existsSync(root)) walk(root);

for (const file of hits) {
  const arch = file.includes("aarch64") ? "aarch64" : "x64";
  const next = join(dirname(file), basename(file).replace(/\.app\.tar\.gz/, `_${arch}.app.tar.gz`));
  if (file === next) continue; // 重跑时不会二次改名
  renameSync(file, next);
  console.log(`→ ${basename(next)}`);
}

console.log(`共处理 ${hits.length} 个文件`);
