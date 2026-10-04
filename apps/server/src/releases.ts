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

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

  /**
   * 文件名 → GitHub 上的下载地址。
   *
   * 同事的电脑多半连不上 GitHub（国内网络），所以**下载页里一律用本站地址**，
   * 由服务器回源到 GitHub 取回来再发给他们（见 openAsset）。
   * 这里记的就是"回源去哪儿取"。
   */
  private readonly assetSources = new Map<string, string>();

  /** 正在回源的文件的等待者，避免两个人同时点同一个包时下载两遍 */
  private readonly inflight = new Map<string, Promise<string>>();

  /** 预热是否在进行中（避免重复跑） */
  private warming = false;

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
  async refresh(force = false): Promise<void> {
    if (!this.githubRepo) return;
    // force：跳过 5 分钟缓存。**发完版点"检查更新"时必须 force**，
    // 否则会拿到刚发布的旧结果、以为没更新。
    if (!force && this.cached && Date.now() - this.cached.at < ReleaseStore.CACHE_MS) return;

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

    // 先把**不是这个版本的**缓存清掉，再预热。
    this.dropStaleAssets(release);

    // 后台把安装包先拉下来。
    //
    // 不预热的话，**第一个点下载的同事要等服务器从 GitHub 取完**——
    // 实测 3.2MB 要 110 秒，体验很差（而且还会超时）。
    // 预热之后所有人都是本地直读（毫秒级）。
    // 刻意不 await：不阻塞这次请求，失败了下次刷新再试。
    void this.warmCache(release);
  }

  /**
   * 丢掉"不属于当前版本"的缓存文件。
   *
   * ## 为什么必须有这一步
   *
   * **安装包文件名跨版本是重复的**（0.1.1 和 0.1.2 都叫
   * `KuaiBan_aarch64.app.tar.gz`）。而缓存是按文件名存的，于是发新版本后
   * 服务器仍然把**旧版本的文件**按同一个 URL 发出去。
   *
   * 后果很隐蔽：清单里的签名是新的、URL 也对，但**文件是旧的**，
   * 客户端下载完做签名校验就会失败（`The signature verification failed`）。
   * 这和"签名缓存串版本"是同一个病根 —— 见 fetchSignature 的注释。
   *
   * ## 为什么用"大小比对"而不是"记住上一次的版本号"
   *
   * 记版本号的话，**进程重启后就忘了**，而那些陈旧文件还在磁盘上、照样会被发出去。
   * 直接拿本地文件大小和当前 Release 声明的大小比，不一致就丢掉 ——
   * 自愈，不依赖任何内存状态。
   */
  private dropStaleAssets(release: GithubRelease): void {
    for (const asset of release.assets) {
      if (asset.size <= 0) continue; // 没给出大小就不敢乱删
      const local = join(this.dir, asset.name);
      try {
        if (!existsSync(local)) continue;
        if (statSync(local).size !== asset.size) {
          unlinkSync(local);
        }
      } catch {
        // 删不掉就算了，下次预热还会再试
      }
    }
  }

  /**
   * 把这次 Release 的安装包预先拉到本地。
   *
   * 只处理"要给同事下载的东西"（安装包 + 更新包 + 签名），
   * 而且已经在本地的不重复拉。
   */
  private async warmCache(release: GithubRelease): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      this.cleanPartials();

      for (const asset of release.assets) {
        if (!/\.(dmg|exe|msi|apk|app\.tar\.gz|nsis\.zip)(\.sig)?$/i.test(asset.name)) continue;
        if (this.resolveFile(asset.name)) continue; // 已经有了
        try {
          await this.ensureAsset(asset.name);
        } catch {
          // 单个文件失败不影响其他；下一次刷新会重试
        }
      }
    } finally {
      this.warming = false;
    }
  }

  /**
   * 清掉上次没下完的 `.partial`。
   *
   * 中断的下载会留下半截文件，不该让它永远占着磁盘。
   */
  private cleanPartials(): void {
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".partial")) continue;
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          /* 删不掉就算了 */
        }
      }
    } catch {
      /* 目录不存在等，忽略 */
    }
  }

  /** GitHub Release → 下载页数据 */
  private listingFromGithub(release: GithubRelease): PublicReleases {
    const bySlot = new Map<string, PublicRelease>();

    // 记下回源地址（同事那边下不动的 GitHub 地址只留给自己用）
    this.assetSources.clear();
    // 记的是 **API 地址**：github.com 直链在国内超时（服务器运维实测）
    for (const asset of release.assets) this.assetSources.set(asset.name, asset.apiUrl);

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
        // ⚠️ **本站地址**，不是 GitHub 地址。同事的电脑连不上 GitHub。
        url: `${this.origin}/downloads/${encodeURIComponent(asset.name)}`,
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

      const signature = await this.fetchSignature(sigAsset, cacheDir, release.version);
      if (!signature) continue;

      // 同样用本站地址 —— 自动更新也得走公司服务器，否则同事那边更新不了
      platforms[target] = {
        signature,
        url: `${this.origin}/downloads/${encodeURIComponent(asset.name)}`,
      };
    }

    if (Object.keys(platforms).length === 0) return null;

    return {
      version: release.version,
      ...(release.notes ? { notes: release.notes } : {}),
      pub_date: release.publishedAt,
      platforms,
    };
  }

  /**
   * 更新包文件名 → Tauri 的平台标识。
   *
   * ⚠️ **认不出架构就返回 null，绝不默认一个。**
   * Tauri 打出来的 macOS 更新包原始文件名是 `KuaiBan.app.tar.gz` —— 里面**没有**
   * 架构信息（架构在目录名 `target/<arch>/release/...` 上，一传到 Release 就丢了）。
   * 如果这时随手默认成某一个，就会**把 Apple 芯片的包装到 Intel 机器上**
   * （或反过来），用户那边直接起不来。
   * 所以 CI 里会先把架构写进文件名（见 .github/workflows/release-client.yml）。
   */
  private targetOf(name: string): string | null {
    if (/\.app\.tar\.gz$/i.test(name)) {
      if (/aarch64|arm64/i.test(name)) return "darwin-aarch64";
      if (/x64|x86_64/i.test(name)) return "darwin-x86_64";
      return null; // 分不清就不发，免得发错
    }
    if (/\.nsis\.zip$/i.test(name)) {
      return /arm64|aarch64/i.test(name) ? "windows-aarch64" : "windows-x86_64";
    }
    return null;
  }

  /**
   * 下载签名文件（并把结果缓存到磁盘，GitHub 抖了也能用上一次的）。
   *
   * ⚠️ **缓存目录必须带上版本号**。
   * Tauri 的签名里带着「签的是哪个版本」（trusted comment 里的 `version:`），
   * 它会拿这个跟清单里的版本比对，对不上就**拒绝更新**并提示
   * "The update was signed for version X but the endpoint announced version Y"。
   *
   * 而更新包的文件名**跨版本是重复的**（0.1.1 和 0.1.2 都叫
   * `KuaiBan_aarch64.app.tar.gz.sig`）。一开始按文件名缓存，于是 0.1.2
   * 直接命中了 0.1.1 的签名 → 服务端把旧签名发出去 → 客户端拒绝更新。
   * 这个错是**真的在客户端上炸出来的**，服务端侧的检查（版本号、URL、签名长度）
   * 全都看不出问题 —— 因为那些确实都是对的，只有签名内容不对。
   */
  private async fetchSignature(
    asset: GithubAsset,
    cacheDir: string,
    version: string,
  ): Promise<string | null> {
    const versionDir = join(cacheDir, version);
    mkdirSync(versionDir, { recursive: true });
    const cached = join(versionDir, asset.name);
    try {
      if (existsSync(cached)) return readFileSync(cached, "utf8").trim();
    } catch {
      /* 读不了就重新下 */
    }

    try {
      const res = await fetch(asset.apiUrl, {
        headers: {
          accept: "application/octet-stream",
          "user-agent": "kuaiban-server",
          ...(this.githubToken ? { authorization: `Bearer ${this.githubToken}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
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

  /**
   * 确保文件在本地；不在就从 GitHub 取回来。
   *
   * 返回本地绝对路径。**边下边存**：第一个点的人会稍微等一下（同时文件
   * 落盘），之后所有人都是本地直读 —— 又快又省事，且**不需要任何人手动上传**。
   */
  async ensureAsset(name: string): Promise<string | null> {
    const local = this.resolveFile(name);
    if (local) return local;

    const source = this.assetSources.get(name);
    if (!source) return null;

    // 已经有人在取同一个文件 → 等他那次，别重复下载
    const running = this.inflight.get(name);
    if (running) {
      try {
        return await running;
      } catch {
        return null;
      }
    }

    const task = this.downloadToCache(name, source);
    this.inflight.set(name, task);
    try {
      return await task;
    } catch {
      return null;
    } finally {
      this.inflight.delete(name);
    }
  }

  private async downloadToCache(name: string, source: string): Promise<string> {
    const target = join(this.dir, name);
    const partial = `${target}.partial`;

    const res = await fetch(source, {
      headers: {
        // 这个头是必须的：不加的话 API 返回的是 JSON 元数据，不是文件本体
        accept: "application/octet-stream",
        "user-agent": "kuaiban-server",
        ...(this.githubToken ? { authorization: `Bearer ${this.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(300_000), // 国内从 GitHub 拉几 MB 实测要 100 秒以上，给足
    });
    if (!res.ok || !res.body) throw new Error(`回源失败：${res.status}`);

    // 先写 .partial，下完再改名 —— 中途断网不会留下一个"看起来能用"的坏包
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(partial);

    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error) => (err ? reject(err) : resolve())));

    const { renameSync } = await import("node:fs");
    renameSync(partial, target);
    return target;
  }

  /** 解析一个下载文件名，防目录穿越 */
  resolveFile(name: string): string | null {
    // 只允许"纯文件名"：不带路径分隔符、不是 .. —— 这是最基本也最要紧的一道门
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }
}
