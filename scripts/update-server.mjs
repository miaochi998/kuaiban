#!/usr/bin/env node
/**
 * 本地更新服务器 —— 用来在**不部署**的前提下验证"应用自己更新自己"。
 *
 * 它做三件事：
 * 1. 扫描 `apps/desktop/src-tauri/target/release/bundle/` 里打好的更新包
 * 2. 自动生成 Tauri 需要的 `latest.json`（版本号 + 下载地址 + minisign 签名）
 * 3. 用 HTTP 把它们发出去
 *
 * 用法：
 *
 *     node scripts/update-server.mjs --port 8899
 *
 * 然后让应用去这个地址查更新（见 docs/在线更新-本地测试.md）。
 *
 * ## 为什么签名必须一起发
 *
 * 客户端烧进了一个 minisign 公钥，**验签不过的包一律不装**。
 * 所以这里必须把 Tauri 打包时生成的 `.sig` 内容原样放进清单 ——
 * 少了它，或者签名对不上，更新会被拒绝（这正是我们要的：防止有人
 * 往更新地址上放任意程序）。
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8899;

const BUNDLE_DIR = resolve("apps/desktop/src-tauri/target/release/bundle");
const VERSION = readVersion();

/** 从 tauri.conf.json 读版本号，免得清单里的版本和打出来的包对不上 */
function readVersion() {
  const conf = JSON.parse(
    readFileSync(resolve("apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  return conf.version;
}

/**
 * 找到更新包并算出它在清单里的 key。
 *
 * Tauri 的 target 命名规则：`darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` …
 * 这里按产物文件名猜，够本地测试用。
 */
function findArtifacts() {
  const found = [];

  if (!existsSync(BUNDLE_DIR)) return found;

  for (const dir of ["macos", "nsis", "msi", "appimage", "deb"]) {
    const full = join(BUNDLE_DIR, dir);
    if (!existsSync(full)) continue;

    for (const name of readdirSync(full)) {
      // 只要"更新用"的压缩包，不要裸的 .app / .dmg
      const isUpdaterArtifact =
        name.endsWith(".app.tar.gz") || name.endsWith(".nsis.zip") || name.endsWith(".AppImage.tar.gz");
      if (!isUpdaterArtifact) continue;

      const sigPath = join(full, `${name}.sig`);
      if (!existsSync(sigPath)) {
        console.warn(`⚠️  ${name} 没有签名文件，跳过（打包时忘了设 TAURI_SIGNING_PRIVATE_KEY？）`);
        continue;
      }

      found.push({
        target: guessTarget(name),
        file: join(full, name),
        name,
        signature: readFileSync(sigPath, "utf8").trim(),
      });
    }
  }

  return found;
}

function guessTarget(name) {
  if (name.includes(".app.tar.gz")) {
    // 本机架构。Apple Silicon 是 aarch64，Intel 是 x86_64
    return process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
  }
  if (name.includes(".nsis.zip")) return "windows-x86_64";
  if (name.includes(".AppImage.tar.gz")) return process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  return "unknown";
}

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".zip": "application/zip",
  ".sig": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/latest.json") {
    const artifacts = findArtifacts();

    if (artifacts.length === 0) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error:
            "没找到更新包。先跑一次打包：" +
            "TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/kuaiban-updater.key " +
            "pnpm --filter @kuaiban/desktop tauri build --config src-tauri/tauri.local-update.conf.json",
        }),
      );
      return;
    }

    const platforms = {};
    for (const a of artifacts) {
      platforms[a.target] = {
        signature: a.signature,
        url: `http://127.0.0.1:${PORT}/${encodeURIComponent(a.name)}`,
      };
    }

    const manifest = {
      version: VERSION,
      notes: `本地测试版本 ${VERSION}`,
      pub_date: new Date().toISOString(),
      platforms,
    };

    console.log(`[更新服务器] 清单已生成：${VERSION} → ${Object.keys(platforms).join(", ")}`);
    res.writeHead(200, { "content-type": MIME[".json"] });
    res.end(JSON.stringify(manifest, null, 2));
    return;
  }

  // 更新包本体
  const name = decodeURIComponent(path.replace(/^\//, ""));
  const artifact = findArtifacts().find((a) => a.name === name);

  if (artifact) {
    const { size } = statSync(artifact.file);
    console.log(`[更新服务器] 发送 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）`);
    res.writeHead(200, {
      "content-type": MIME[extname(name)] ?? "application/octet-stream",
      "content-length": size,
    });
    createReadStream(artifact.file).pipe(res);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("没有这个文件");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("─".repeat(62));
  console.log(`[更新服务器] http://127.0.0.1:${PORT}/latest.json`);
  console.log(`[更新服务器] 当前版本：${VERSION}`);
  console.log(`[更新服务器] 产物目录：${BUNDLE_DIR}`);
  const found = findArtifacts();
  if (found.length === 0) {
    console.log("[更新服务器] ⚠️  还没有更新包 —— 先按 docs/在线更新-本地测试.md 打包");
  } else {
    for (const a of found) console.log(`[更新服务器]   ✓ ${a.target}  ${a.name}`);
  }
  console.log("─".repeat(62));
});
