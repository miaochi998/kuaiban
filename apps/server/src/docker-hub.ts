/**
 * 从 Docker Hub 读镜像 tag
 *
 * ## 为什么后台改读这里，而不是 GitHub Release
 *
 * 后台要回答的问题是"**服务端能不能升到新版本**"。而服务端版本的真正来源是
 * **镜像 tag** —— 之前却去读 GitHub Release 的版本号，那是**客户端**的发布记录。
 *
 * 两者绑在一起带来一个具体问题：
 *   只发服务端镜像（不发客户端）时**不会产生 GitHub Release**，
 *   于是后台根本看不到这个新版本、也就升不了 ——
 *   "服务端独立发版"这件事就做不成。
 *
 * 改为直接读镜像 tag 之后：**发了镜像，后台就能看见、就能升**，
 * 客户端发不发与它无关。
 */

const TIMEOUT_MS = 10_000;

export interface DockerHubTags {
  /** 形如 0.1.11 的版本 tag（已剔除 latest / dev 之类） */
  versions: string[];
  /** 仓库是否存在、是否读得到 */
  ok: boolean;
}

/** 只认严格的 x.y.z —— 其它 tag（latest、日期、分支名）不参与"最新版本"比较 */
export function isVersionTag(name: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(name);
}

/** 语义化比较（和后台界面用的是同一套规则） */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 从一堆 tag 里挑出版本号最大的那个 */
export function pickLatestVersion(names: readonly string[]): string | null {
  const versions = names.filter(isVersionTag);
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareVersion(v, best) > 0 ? v : best));
}

/**
 * 读某个镜像仓库的全部 tag。
 *
 * `repo` 形如 `miaochi/kuaiban-server`。
 * 读不到（网络不通、仓库不存在）时返回 `ok: false`，**由调用方决定退回哪种方案**，
 * 不要在这里假装"没有新版本"。
 */
export async function fetchImageTags(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DockerHubTags> {
  const clean = repo.trim().replace(/^docker\.io\//, "");
  if (!/^[^/]+\/[^/]+$/.test(clean)) return { versions: [], ok: false };

  try {
    const res = await fetchImpl(
      `https://hub.docker.com/v2/repositories/${clean}/tags?page_size=100&ordering=last_updated`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { versions: [], ok: false };
    const body = (await res.json()) as { results?: { name?: string }[] };
    const names = (body.results ?? []).map((r) => r.name ?? "").filter(Boolean);
    return { versions: names.filter(isVersionTag), ok: true };
  } catch {
    return { versions: [], ok: false };
  }
}
