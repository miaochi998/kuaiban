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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  fetchLatestRelease,
  macosArch,
  platformOf,
  type GithubAsset,
  type GithubRelease,
} from "./github-releases.ts";

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

/** 从 GitHub 读来的快照，缓存在内存里，避免每次请求都打 GitHub（会被限流） */
interface RemoteSnapshot {
  at: number;
  listing: PublicReleases;
  updater: { version: string; notes?: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> } | null;
}

export class ReleaseStore {
  /** 发布目录：本地清单、签名缓存都在这儿 */
  readonly dir: string;
  /** 对外域名，例如 https://kuaiban.bonnei.com（末尾不留斜杠） */
  readonly origin: string;
  /** 客户端 Release 所在的仓库（owner/repo）。不设就只用本地清单（本地开发） */
  private readonly githubRepo: string | null;
  private readonly githubToken: string | undefined;

  /** 缓存多久去问一次 GitHub。5 分钟：内部工具没必要更勤 */
  private static readonly CACHE_MS = 5 * 60_000;
  private cached: RemoteSnapshot | null = null;

  constructor(opts: { dir: string; origin: string; githubRepo?: string; githubToken?: string }) {
    this.dir = opts.dir;
    this.origin = opts.origin.replace(/\/+$/, "");
    this.githubRepo = opts.githubRepo?.trim() || null;
    this.githubToken = opts.githubToken;
  }

  /**
   * 刷新一次远端信息（GitHub Release）。
   *
   * 失败时**保留上一次成功的结果** —— 网络抖一下不该让下载页变成空白。
   * 从没成功过才退回本地清单（本地开发用）。
   */
  async refresh(): Promise<void> {
    if (!this.githubRepo) return;
    if (this.cached && Date.now() - this.cached.at < ReleaseStore.CACHE_MS) return;

    const release = await fetchLatestRelease({
      repo: this.githubRepo,
      ...(this.githubToken ? { token: this.githubToken } : {}),
    });
    if (!release) return; // 拿不到就用旧缓存/本地清单

    this.cached = {
      at: Date.now(),
      listing: this.listingFromGithub(release),
      updater: await this.updaterFromGithub(release),
    };
  }

  /** GitHub Release → 下载页数据 */
  private listingFromGithub(release: GithubRelease): PublicReleases {
    const bySlot = new Map<string, PublicRelease>();

    for (const asset of release.assets) {
      const platform = platformOf(asset.name);
      if (!platform) continue;

      const key =
        platform === "macos"
          ? macosArch(asset.name)
          : platform === "windows"
            ? "windows"
            : "android";
      if (!key) continue;

      const slot = PLATFORM_SLOTS.find((s) => s.key === key)!;
      bySlot.set(key, {
        key,
        label: slot.label,
        hint: slot.hint,
        kind: slot.kind,
        file: asset.name,
        url: asset.url,
        sizeLabel: humanSize(asset.size),
        available: true,
      });
    }

    const platforms = PLATFORM_SLOTS.map(
      (slot): PublicRelease =>
        bySlot.get(slot.key) ?? {
          key: slot.key,
          label: slot.label,
          hint: slot.hint,
          kind: slot.kind,
          file: "",
          url: "",
          sizeLabel: null,
          available: false,
        },
    );

    return {
      version: release.version,
      releasedAt: release.publishedAt,
      notes: release.notes || null,
      platforms,
    };
  }

  /**
   * GitHub Release → Tauri 更新清单。
   *
   * Tauri 要求把**签名内容**内嵌进清单，所以必须把 `.sig` 文件拿下来
   * （几百字节，很便宜）。安装包本体不搬，下载地址直接指向 GitHub。
   */
  private async updaterFromGithub(release: GithubRelease): Promise<RemoteSnapshot["updater"]> {
    const cacheDir = join(this.dir, "sig-cache");
    mkdirSync(cacheDir, { recursive: true });

    const platforms: Record<string, { signature: string; url: string }> = {};

    // 自动更新的包：macOS 是 .app.tar.gz、Windows 是 .nsis.zip
    const updaterAssets = release.assets.filter((a) => /\.(app\.tar\.gz|nsis\.zip)$/i.test(a.name));
    if (updaterAssets.length === 0) return null;

    for (const asset of updaterAssets) {
      const target = this.targetOf(asset.name);
      if (!target) continue;

      const sigAsset = release.assets.find((a) => a.name === `${asset.name}.sig`);
      if (!sigAsset) continue;

      const signature = await this.fetchSignature(sigAsset, cacheDir);
      if (!signature) continue;

      platforms[target] = { signature, url: asset.url };
    }

    if (Object.keys(platforms).length === 0) return null;

    return {
      version: release.version,
      ...(release.notes ? { notes: release.notes } : {}),
      pub_date: release.publishedAt,
      platforms,
    };
  }

  /** 更新包文件名 → Tauri 的平台标识 */
  private targetOf(name: string): string | null {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    if (/\.app\.tar\.gz$/i.test(name)) {
      // macOS 的更新包里架构是靠文件名区分的
      const macArch = /aarch64|arm64/i.test(name) ? "aarch64" : "x86_64";
      return `darwin-${macArch}`;
    }
    if (/\.nsis\.zip$/i.test(name)) return "windows-x86_64";
    void arch;
    return null;
  }

  /** 下载签名文件（并把结果缓存到磁盘，GitHub 抖了也能用上一次的） */
  private async fetchSignature(
    asset: GithubAsset,
    cacheDir: string,
  ): Promise<string | null> {
    const cached = join(cacheDir, asset.name);
    try {
      if (existsSync(cached)) return readFileSync(cached, "utf8").trim();
    } catch {
      /* 读不了就重新下 */
    }

    try {
      const res = await fetch(asset.url, {
        headers: this.githubToken ? { authorization: `Bearer ${this.githubToken}` } : {},
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      writeFileSync(cached, text);
      return text;
    } catch {
      return null;
    }
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
    if (this.cached) return this.cached.listing;
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
    if (this.cached?.updater) return this.cached.updater;

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
