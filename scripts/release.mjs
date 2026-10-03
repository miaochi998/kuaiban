#!/usr/bin/env node
/**
 * 一条命令发版
 *
 *     node scripts/release.mjs 0.1.2
 *
 * 它会把打包、签名、生成更新清单全都做完，**你不需要碰私钥**。
 *
 * ## 关于那把签名私钥（这是用户最该关心的事）
 *
 * ### 为什么必须有它
 *
 * Tauri 的自动更新**强制要求**更新包带签名（我们试过删掉，它直接报
 * `missing field pubkey` 拒绝打包）。它防的是"**能往更新地址放文件的人
 * 给全公司推任意程序**"——比如服务器被入侵、或者上传目录配错。
 *
 * ### 它放在哪儿
 *
 * **跟服务器数据放一起**，不放在你自己的电脑上、也不放在仓库里：
 *
 *     服务器数据目录/
 *       ├── kuaiban.db                  ← 所有人的待办
 *       └── kuaiban-updater.key         ← 更新签名私钥
 *
 * 这样做只有一个理由：**你本来就必须备份服务器数据**（丢了所有人的待办）。
 * 让私钥搭上这趟车，你就不需要"额外记住一个文件"——
 * 那个"一定会忘"的问题就不存在了。
 *
 * 查找顺序（第一个找到的就算）：
 *   1. 环境变量 `KUAIBAN_UPDATER_KEY`
 *   2. `$KUAIBAN_DATA_DIR/kuaiban-updater.key`（服务器数据目录）
 *   3. `./.keys/kuaiban-updater.key`（本地开发用，已在 .gitignore 里）
 *   4. `~/.tauri/kuaiban-updater.key`
 *
 * ### 万一真的丢了
 *
 * 不是灾难，是**一次性麻烦**：
 *   1. `node scripts/release.mjs --rotate-key`  生成一把新钥匙
 *   2. 手动给所有人装一次新版本（发个下载链接就行）
 *   3. 从那以后自动更新照常工作
 *
 * 因为已装好的客户端里烧的是旧公钥，换钥匙它就不认了 —— 仅此而已。
 *
 * ### 绝不能做的事
 *
 * **不要把私钥提交进仓库。** 有了它就能签出装到全公司机器上的程序；
 * 仓库一旦泄露（或者有外部协作者），等于把所有人的电脑交出去。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rotate = args.includes("--rotate-key");
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const ROOT = resolve(import.meta.dirname, "..");
const TAURI_DIR = join(ROOT, "apps/desktop/src-tauri");
const BUNDLE_DIR = join(TAURI_DIR, "target/release/bundle");

/** 服务器数据目录 —— 私钥和数据库都放这儿，一次备份全都带走 */
const DATA_DIR =
  process.env.KUAIBAN_DATA_DIR ?? join(homedir(), "Library/Application Support/com.kuaiban.server");

/** 找私钥；找不到就（可选地）生成一把 */
function resolveKey({ create = false } = {}) {
  const candidates = [
    process.env.KUAIBAN_UPDATER_KEY,
    join(DATA_DIR, "kuaiban-updater.key"),
    join(ROOT, ".keys/kuaiban-updater.key"),
    join(homedir(), ".tauri/kuaiban-updater.key"),
  ].filter(Boolean);

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  if (!create) return null;

  const target = join(DATA_DIR, "kuaiban-updater.key");
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`没有找到签名私钥，正在生成一把新的：${target}`);
  execFileSync(
    "pnpm",
    ["exec", "tauri", "signer", "generate", "-w", target, "-p", "", "--force"],
    { cwd: join(ROOT, "apps/desktop"), stdio: "inherit" },
  );
  return target;
}

function copyPublicKeyIntoConfig(keyPath) {
  const pubPath = `${keyPath}.pub`;
  if (!existsSync(pubPath)) throw new Error(`找不到公钥：${pubPath}`);

  const pubkey = readFileSync(pubPath, "utf8").trim();
  const confPath = join(TAURI_DIR, "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));

  if (conf.plugins?.updater?.pubkey === pubkey) return false;

  conf.plugins ??= {};
  conf.plugins.updater ??= {};
  conf.plugins.updater.pubkey = pubkey;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  return true;
}

function bumpVersion(next) {
  const confPath = join(TAURI_DIR, "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  conf.version = next;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

  const cargoPath = join(TAURI_DIR, "Cargo.toml");
  const cargo = readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`);
  writeFileSync(cargoPath, cargo);
}

function findArtifacts() {
  const out = [];
  const macos = join(BUNDLE_DIR, "macos");
  if (!existsSync(macos)) return out;

  for (const name of readdirSync(macos)) {
    if (!name.endsWith(".app.tar.gz")) continue;
    const sig = join(macos, `${name}.sig`);
    if (!existsSync(sig)) continue;
    out.push({
      target: process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64",
      file: join(macos, name),
      name,
      signature: readFileSync(sig, "utf8").trim(),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────

if (rotate) {
  const existing = resolveKey();
  if (existing) {
    const backup = `${existing}.old-${Date.now()}`;
    copyFileSync(existing, backup);
    console.log(`旧钥匙已备份到：${backup}`);
    console.log("（如果只是暂时换，之后还能换回来；真要作废就删掉它）");
  }
  const keyPath = resolveKey({ create: true });
  copyPublicKeyIntoConfig(keyPath);
  console.log("");
  console.log("═".repeat(64));
  console.log("已生成新的签名钥匙。");
  console.log("");
  console.log("⚠️  已装好的客户端里烧的是**旧公钥**，它们不会接受用新钥匙签的更新。");
  console.log("    所以你需要：手动给所有人装一次这个新版本（发个下载链接就行），");
  console.log("    之后自动更新就恢复正常了。");
  console.log("═".repeat(64));
  process.exit(0);
}

if (!version) {
  const conf = JSON.parse(readFileSync(join(TAURI_DIR, "tauri.conf.json"), "utf8"));
  console.error("用法：node scripts/release.mjs <新版本号>");
  console.error(`      例如：node scripts/release.mjs 0.1.2`);
  console.error(`      （当前版本 ${conf.version}）`);
  console.error("");
  console.error("      钥匙丢了/想换：node scripts/release.mjs --rotate-key");
  process.exit(1);
}

const keyPath = resolveKey({ create: true });
console.log(`签名私钥：${keyPath}`);
if (copyPublicKeyIntoConfig(keyPath)) {
  console.log("公钥已写入 tauri.conf.json（首次使用这把钥匙）");
}

console.log(`版本号：${version}`);
bumpVersion(version);

console.log("开始打包（要几分钟）…");
execFileSync("pnpm", ["--filter", "@kuaiban/desktop", "tauri", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
});

const artifacts = findArtifacts();
if (artifacts.length === 0) {
  console.error("❌ 没找到带签名的更新包 —— 打包可能失败了");
  process.exit(1);
}

const manifest = {
  version,
  notes: `快办 ${version}`,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    artifacts.map((a) => [a.target, { signature: a.signature, url: `<把 ${a.name} 传到更新目录后的地址>` }]),
  ),
};

const outPath = join(BUNDLE_DIR, "latest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

// ── 同时更新"发布下载页"用的清单 ──
// 服务端只读它、不猜 —— 猜"哪个文件最新"猜错了就会给人发旧版本。
const releasesDir = join(DATA_DIR, "releases");
mkdirSync(releasesDir, { recursive: true });

const downloads = {};
for (const a of artifacts) {
  if (a.name.endsWith(".app.tar.gz")) continue; // 更新包不给用户手动下
  downloads[/arm64|aarch64/.test(a.name) || process.arch === "arm64" ? "macos-arm64" : "macos-intel"] = {
    file: a.name,
  };
}
// DMG 是给人手动装的；.app.tar.gz 是给自动更新用的，两者都要复制过去
for (const dir of ["macos", "nsis", "msi", "dmg"]) {
  const from = join(BUNDLE_DIR, dir);
  if (!existsSync(from)) continue;
  for (const name of readdirSync(from)) {
    if (!/\.(dmg|exe|msi|apk|zip|tar\.gz)$/.test(name)) continue;
    copyFileSync(join(from, name), join(releasesDir, name));
  }
}

// 从文件名里认出 DMG，让它出现在下载页上
for (const name of readdirSync(releasesDir)) {
  if (!name.endsWith(".dmg")) continue;
  const key = /aarch64|arm64/.test(name) ? "macos-arm64" : "macos-intel";
  downloads[key] = { file: name };
}

const releasesManifest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: `快办 ${version}`,
  downloads,
  updates: Object.fromEntries(
    artifacts.map((a) => [a.target, { file: a.name, signature: a.signature }]),
  ),
};
writeFileSync(join(releasesDir, "releases.json"), JSON.stringify(releasesManifest, null, 2) + "\n");

console.log("");
console.log("═".repeat(64));
console.log(`✅ ${version} 打好了，已签名`);
for (const a of artifacts) console.log(`   ${a.file}`);
console.log("");
console.log(`更新清单：${outPath}`);
console.log(`发布清单：${join(releasesDir, "releases.json")}`);
console.log(`安装包已就位：${releasesDir}`);
console.log("");
console.log("下载页会立刻反映这个版本 —— 服务端读的就是上面那份清单。");
console.log("═".repeat(64));
