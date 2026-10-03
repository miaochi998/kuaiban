/**
 * 从 GitHub Release 自动获取客户端版本
 *
 * ## 为什么不用"人把安装包传到服务器"
 *
 * 用户的原话：「每次更新版本后的操作是不是手动把新的安装包上传到服务器？」
 * —— 是，那就是设计错了。凡是"每次发版都要人记得做一步"的流程，早晚会漏。
 *
 * 所以改成：**打一个 git tag，其他全自动**。
 *
 *     git tag v0.1.2 && git push --tags
 *            ↓ GitHub Actions
 *       构建安装包 → 签名 → 发 GitHub Release
 *            ↓ 服务端读 Release（本文件）
 *       下载页 + 自动更新清单，同时生效
 *
 * ## 国内网络的关键约束（服务器运维实测）
 *
 * `github.com` 在国内**不可达**（超时），但 **`api.github.com` 可达**。
 * 所以下载资源**必须走 API 通道**：
 *
 *     GET https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>
 *     Accept: application/octet-stream
 *
 * 用 `browser_download_url`（`github.com/.../releases/download/...`）必然超时。
 *
 * ## 只下载签名文件，不搬安装包
 *
 * 安装包本体（3～6MB）留在 GitHub，下载地址直接指向它 —— 服务端不当中转站，
 * 省磁盘也省带宽。唯一要拿下来的是 `.sig` 签名文件（几百字节），
 * 因为 Tauri 的更新清单要求把**签名内容**内嵌进去。
 */

/** GitHub Release 里我们认得的资源（靠文件名后缀） */
const DESKTOP_ASSETS: { match: RegExp; platform: "macos" | "windows" | "android" }[] = [
  { match: /\.dmg$/i, platform: "macos" },
  { match: /\.exe$|\.msi$/i, platform: "windows" },
  { match: /\.apk$/i, platform: "android" },
];

export interface GithubAsset {
  name: string;
  /**
   * **API 资源地址**（`api.github.com/repos/.../releases/assets/<id>`）。
   *
   * ⚠️ 刻意不用 `browser_download_url`：那个是 `github.com/...` 的直链，
   * **在国内网络下会超时**（实测 `github.com` 不可达，`api.github.com` 可达）。
   * 走 API 地址 + `Accept: application/octet-stream` 才能真的把文件拿下来。
   * （这条是服务器运维实测反馈的，不是推测。）
   */
  apiUrl: string;
  /** 浏览器下载地址。**只用于本地开发/境外网络**，国内不要用 */
  browserUrl: string;
  size: number;
}

export interface GithubRelease {
  version: string;
  publishedAt: string;
  notes: string;
  assets: GithubAsset[];
}

/** GitHub 请求超时。内网服务器出海可能不快，但也不能一直挂着 */
const TIMEOUT_MS = 8_000;

function parseRepo(repo: string): { owner: string; name: string } | null {
  const m = /^([^/]+)\/([^/]+)$/.exec(repo.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/**
 * 读最新 Release。
 *
 * `token` 可选：仓库是私有的就必须给（只读权限的 token 即可）。
 * 注意**不要把 token 写进代码或镜像** —— 从环境变量来。
 */
export async function fetchLatestRelease(opts: {
  repo: string;
  token?: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<GithubRelease | null> {
  const parsed = parseRepo(opts.repo);
  if (!parsed) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await doFetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.name}/releases/latest`,
      {
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "kuaiban-server",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
    );

    if (!res.ok) return null;

    const json = (await res.json()) as {
      tag_name?: string;
      published_at?: string;
      body?: string;
      assets?: { name: string; url: string; browser_download_url: string; size: number }[];
    };

    // tag 形如 v0.1.2 —— 版本号不带 v
    const version = (json.tag_name ?? "").replace(/^v/, "");
    if (!version) return null;

    return {
      version,
      publishedAt: json.published_at ?? new Date().toISOString(),
      notes: json.body ?? "",
      assets: (json.assets ?? []).map((a) => ({
        name: a.name,
        apiUrl: a.url, // api.github.com/…/releases/assets/<id>
        browserUrl: a.browser_download_url,
        size: a.size,
      })),
    };
  } catch {
    // 网络不通、GitHub 挂了、被限流 —— 一律当作"暂时拿不到"，
    // 让调用方退回上一次成功的结果，而不是把下载页搞成报错页
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 某个资源属于哪个平台槽位（认不出来就返回 null） */
export function platformOf(assetName: string): "macos" | "windows" | "android" | null {
  for (const rule of DESKTOP_ASSETS) {
    if (rule.match.test(assetName)) return rule.platform;
  }
  return null;
}

/**
 * macOS 安装包是 Apple 芯片还是 Intel。
 *
 * Tauri 打出来的文件名里带 `aarch64` 或 `x64`，据此区分 —— 这是**必须**区分的：
 * 装错了芯片的包，用户那边直接打不开。
 */
export function macosArch(assetName: string): "macos-arm64" | "macos-intel" | null {
  if (!/\.dmg$/i.test(assetName)) return null;
  if (/aarch64|arm64/i.test(assetName)) return "macos-arm64";
  if (/x64|x86_64/i.test(assetName)) return "macos-intel";
  return null;
}
