/**
 * 发布清单与下载
 *
 * 服务器上有一个"发布目录"，发版脚本往里丢安装包、更新包和一份清单：
 *
 * ```
 * <发布目录>/
 *   ├── releases.json               ← 清单（哪个平台、什么版本、哪个文件）
 *   ├── KuaiBan_0.1.1_aarch64.dmg   ← 给人手动下载的安装包
 *   └── KuaiBan.app.tar.gz          ← 给自动更新用的包（带 .sig）
 * ```
 *
 * 服务端**不生成清单**，只读它 —— 谁发的版谁说清楚，服务端别自作聪明去
 * 猜"哪个文件是最新的"（猜错了就会给人发旧版本）。
 *
 * ## 所有对外地址都从 PUBLIC_ORIGIN 拼出来
 *
 * 正式域名只有一个（`kuaiban.bonnei.com`），而且**不能写在清单里** ——
 * 清单里存相对路径，服务端按当前部署的域名拼成绝对地址。
 * 这样换域名（或本地测试）不用重新发一遍版。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 下载页上会出现的平台。写死一份，保证顺序稳定、缺的也显示"即将推出" */
export const PLATFORM_SLOTS = [
  { key: "macos-arm64", label: "macOS", hint: "Apple 芯片（M 系列）", kind: "desktop" },
  { key: "macos-intel", label: "macOS", hint: "Intel 芯片", kind: "desktop" },
  { key: "windows", label: "Windows", hint: "Windows 10 / 11（64 位）", kind: "desktop" },
  { key: "android", label: "Android", hint: "安卓手机 / 平板", kind: "mobile" },
  { key: "harmony", label: "鸿蒙", hint: "HarmonyOS NEXT", kind: "mobile" },
  { key: "ios", label: "iOS", hint: "iPhone / iPad", kind: "mobile" },
] as const;

export interface ReleaseEntry {
  file: string;
  size?: number;
}

export interface ReleaseManifest {
  version: string;
  releasedAt: string;
  notes?: string;
  /** 给人下载的安装包：平台 key → 文件 */
  downloads: Record<string, ReleaseEntry>;
  /** 自动更新用的包：Tauri 平台标识 → { 文件, 签名 } */
  updates?: Record<string, { file: string; signature: string }>;
}

export interface PublicRelease extends ReleaseEntry {
  key: string;
  label: string;
  hint: string;
  kind: string;
  /** 绝对下载地址，直接用根域名拼 */
  url: string;
  /** 文件大小（给用户一个心理预期），读不到就是 null */
  sizeLabel: string | null;
  available: boolean;
}

export interface PublicReleases {
  version: string | null;
  releasedAt: string | null;
  notes: string | null;
  platforms: PublicRelease[];
}

function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class ReleaseStore {
  /** 发布目录：安装包与清单都在这儿 */
  readonly dir: string;
  /** 对外域名，例如 https://kuaiban.bonnei.com（末尾不留斜杠） */
  readonly origin: string;

  constructor(opts: { dir: string; origin: string }) {
    this.dir = opts.dir;
    this.origin = opts.origin.replace(/\/+$/, "");
  }

  /** 读清单。读不到或者格式不对都返回 null —— 下载页要能优雅地显示"暂无" */
  read(): ReleaseManifest | null {
    const path = join(this.dir, "releases.json");
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
      if (!parsed.version || !parsed.downloads) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 给下载页用的数据：每个平台槽位都在，没包的显示成"即将推出" */
  publicListing(): PublicReleases {
    const manifest = this.read();
    const platforms = PLATFORM_SLOTS.map((slot): PublicRelease => {
      const entry = manifest?.downloads?.[slot.key];
      const path = entry ? join(this.dir, entry.file) : null;
      const onDisk = path && existsSync(path) ? statSync(path).size : null;

      return {
        key: slot.key,
        label: slot.label,
        hint: slot.hint,
        kind: slot.kind,
        file: entry?.file ?? "",
        url: entry ? `${this.origin}/downloads/${encodeURIComponent(entry.file)}` : "",
        sizeLabel: onDisk !== null ? humanSize(onDisk) : null,
        available: Boolean(entry && path && existsSync(path)),
      };
    });

    return {
      version: manifest?.version ?? null,
      releasedAt: manifest?.releasedAt ?? null,
      notes: manifest?.notes ?? null,
      platforms,
    };
  }

  /** 给 Tauri 自动更新用的清单（格式由 Tauri 定，改不了） */
  updaterManifest(): { version: string; notes?: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> } | null {
    const manifest = this.read();
    if (!manifest?.updates) return null;

    const platforms: Record<string, { signature: string; url: string }> = {};
    for (const [target, entry] of Object.entries(manifest.updates)) {
      platforms[target] = {
        signature: entry.signature,
        url: `${this.origin}/downloads/${encodeURIComponent(entry.file)}`,
      };
    }

    return {
      version: manifest.version,
      ...(manifest.notes ? { notes: manifest.notes } : {}),
      pub_date: manifest.releasedAt,
      platforms,
    };
  }

  /** 解析一个下载文件名，防目录穿越 */
  resolveFile(name: string): string | null {
    // 只允许"纯文件名"：不带路径分隔符、不是 .. —— 这是最基本也最要紧的一道门
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }
}
