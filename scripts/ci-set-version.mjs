/**
 * 把版本号同步进 tauri.conf.json 与 Cargo.toml（CI 用）
 *
 * 为什么单独放一个文件而不是写在 workflow 里内联执行：
 * YAML → shell → node 三层转义叠加，正则里的 `\d` 会变成 `\\d`，
 * 结果"0.1.1"被判成非法版本号（真踩过）。独立文件没有转义问题。
 *
 * 也刻意不用 sed：`sed "0,/^version = /s//version = \"x\"/"` 里的 `s//repl/`
 * 只替换匹配到的那一小段，**旧版本号会留在后面**，写出 `version = "0.1.1""0.1.1"`，
 * Cargo 直接报 TOML 解析错误。
 */

import { readFileSync, writeFileSync } from "node:fs";

const raw = process.env.VERSION_INPUT || process.env.GITHUB_REF_NAME || "";
const version = raw.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`版本号不合法：${JSON.stringify(version)}（原始值 ${JSON.stringify(raw)}）`);
  process.exit(1);
}

const confPath = "apps/desktop/src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const cargoPath = "apps/desktop/src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
writeFileSync(cargoPath, cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`));

console.log(`版本已同步为 ${version}`);
