/**
 * 服务端在线升级
 *
 * ## 为什么要有它
 *
 * 服务端自己也会更新（修 bug、加功能）。如果每次都要人去 Portainer 点几下，
 * 那就又变成了"每次发版都要人记得做一步"—— 用户明确不想要这种流程。
 * 所以做成：**管理后台点两下就能升**。
 *
 * ## 怎么升
 *
 * 调 **Portainer 的 API** 更新堆栈：把 `KUAIBAN_IMAGE` 改成新版本的镜像地址，
 * 并让 Portainer 重新拉镜像重建容器。
 * （这和用户现有其他应用（bnoa / 7DL）的做法一致，运维也确认过可行。）
 *
 * ## 两套环境
 *
 * 用户的部署流程是**先在测试机验证、没问题再升正式机**，所以配置里有两个环境。
 * 页面上选一个升级 —— 刻意不做"一键全升"，那会把"先验证"这个安全步骤抹掉。
 *
 * ## 凭据放哪
 *
 * Portainer 的 API Key 存在**数据库**里（与 bnoa 一致），不放 compose、不放代码、
 * 不经过聊天。页面回显时只给"已配置/未配置"，**绝不把 Key 发回浏览器**。
 */

import { fetchNewestRelease } from "./github-releases.ts";
import { compareVersion as cmpTag, fetchImageTags, pickLatestVersion } from "./docker-hub.ts";
import type { Store } from "./store.ts";

/** 一个可升级的环境（测试 / 正式） */
export interface UpgradeEnvConfig {
  /** 环境标识：test | production */
  key: string;
  label: string;
  /** Portainer 地址，例如 http://192.168.2.6:9000 */
  portainerUrl: string;
  /** Portainer API Key。**最高敏感**：CE 版的 Key 等同管理员，能操作该主机上全部 Stack */
  apiKey: string;
  stackId: string;
  endpointId: string;
  /** 要改的环境变量名，默认 KUAIBAN_IMAGE */
  imageVar: string;
}

export interface UpgradeConfig {
  /** GitHub 仓库（仅供客户端版本相关用途；服务端版本已改读镜像 tag） */
  githubRepo: string;
  githubToken: string;
  /**
   * 服务端镜像名（如 `miaochi/kuaiban-server`）。
   * **服务端版本就从它的 tag 读** —— 存在这里而不是只放在浏览器里，
   * 否则后台刷新/换浏览器之后就不知道去哪查版本了。
   */
  imageName: string;
  envs: UpgradeEnvConfig[];
}

const SETTINGS_KEY = "upgrade_config";

/** 没配过时的默认骨架（地址按运维给的填好，Key 留空等管理员填） */
export function defaultUpgradeConfig(): UpgradeConfig {
  return {
    githubRepo: "",
    githubToken: "",
    imageName: "miaochi/kuaiban-server",
    envs: [
      {
        key: "test",
        label: "测试",
        portainerUrl: "http://192.168.2.6:9000",
        apiKey: "",
        stackId: "",
        endpointId: "1",
        imageVar: "KUAIBAN_IMAGE",
      },
      {
        key: "production",
        label: "正式",
        portainerUrl: "http://192.168.2.10:9000",
        apiKey: "",
        stackId: "",
        endpointId: "1",
        imageVar: "KUAIBAN_IMAGE",
      },
    ],
  };
}

export function loadUpgradeConfig(store: Store): UpgradeConfig {
  const raw = store.getSetting(SETTINGS_KEY);
  if (!raw) return defaultUpgradeConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<UpgradeConfig>;
    const base = defaultUpgradeConfig();
    return {
      githubRepo: parsed.githubRepo ?? base.githubRepo,
      githubToken: parsed.githubToken ?? base.githubToken,
      imageName: parsed.imageName || base.imageName,
      // 逐个环境合并：新增的默认环境不会因为旧配置里没有而消失
      envs: base.envs.map((slot) => ({
        ...slot,
        ...(parsed.envs?.find((e) => e.key === slot.key) ?? {}),
      })),
    };
  } catch {
    return defaultUpgradeConfig();
  }
}

export function saveUpgradeConfig(store: Store, config: UpgradeConfig): void {
  store.setSetting(SETTINGS_KEY, JSON.stringify(config));
}

/** 给界面看的形态：**把 API Key 换成一个布尔值**，绝不回传 */
export function publicUpgradeConfig(config: UpgradeConfig): unknown {
  return {
    githubRepo: config.githubRepo,
    hasGithubToken: config.githubToken.length > 0,
    imageName: config.imageName,
    envs: config.envs.map((e) => ({
      key: e.key,
      label: e.label,
      portainerUrl: e.portainerUrl,
      hasApiKey: e.apiKey.length > 0,
      stackId: e.stackId,
      endpointId: e.endpointId,
      imageVar: e.imageVar,
    })),
  };
}

/**
 * 比较两个版本号。
 *
 * 原来直接用 `!==` 判断"有没有更新"，于是 `current 0.1.4 / latest 0.1.2`
 * 也会报"有更新" —— 实际上 0.1.4 更新。日常看不出来，
 * 但**正式走服务端升级流程时会误导人**（让人以为还该升到更旧的版本）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  error: string | null;
}

/**
 * 查服务端有没有新版本。
 *
 * **主用 Docker Hub 的镜像 tag**：后台要回答的是"服务端能不能升"，
 * 而服务端版本的真正来源就是镜像 tag。这样"只发服务端镜像、不发客户端"
 * 也能被后台看见并升级（客户端发不发与它无关）。
 *
 * 读不到 Docker Hub 时才退回 GitHub Release 的版本号作为兜底。
 */
export async function checkServerUpdate(opts: {
  config: UpgradeConfig;
  currentVersion: string;
}): Promise<UpdateCheck> {
  const image = opts.config.imageName || "miaochi/kuaiban-server";

  const tags = await fetchImageTags(image);
  if (tags.ok) {
    const latest = pickLatestVersion(tags.versions);
    if (!latest) {
      return { current: opts.currentVersion, latest: null, hasUpdate: false, error: `镜像 ${image} 还没有版本 tag` };
    }
    return {
      current: opts.currentVersion,
      latest,
      // 只有"镜像里有比当前更新的版本"才算有更新
      hasUpdate: compareVersions(latest, opts.currentVersion) > 0,
      error: null,
    };
  }

  // ── 兜底：Docker Hub 读不到（网络/仓库问题）时看 GitHub Release ──
  const repo = opts.config.githubRepo || process.env.KUAIBAN_GITHUB_REPO || "";
  if (!repo) {
    return { current: opts.currentVersion, latest: null, hasUpdate: false, error: `读不到镜像 ${image} 的 tag，也没配 GitHub 仓库` };
  }

  // 用 fetchNewestRelease 而不是 fetchLatestRelease ——
  // 服务端"只发镜像"时建的 Release **不含客户端产物**，用后者会漏看它。
  const release = await fetchNewestRelease({
    repo,
    ...(opts.config.githubToken || process.env.KUAIBAN_GITHUB_TOKEN
      ? { token: opts.config.githubToken || process.env.KUAIBAN_GITHUB_TOKEN }
      : {}),
  });

  if (!release) {
    return { current: opts.currentVersion, latest: null, hasUpdate: false, error: "读不到 GitHub Release" };
  }

  return {
    current: opts.currentVersion,
    latest: release.version,
    // 只有"服务端比当前新"才算有更新
    hasUpdate: cmpTag(release.version, opts.currentVersion) > 0,
    error: null,
  };
}

/**
 * 读某个环境【自己】当前跑的版本。
 *
 * ## 为什么必须有它
 *
 * 原来后台只显示一个"当前版本"，而那其实是**提供这个页面的服务器自己**的版本
 * （你打开 https://kuaiban.bonnei.com/admin 就是正式机提供的）。
 * 于是一个数字被两个环境共用，切来切去都一样 —— 用户根本分不清
 * 升的到底是哪台、成没成功。
 *
 * 这里直接去**目标环境的 Portainer** 读它 Stack 上的 KUAIBAN_VERSION，
 * 那才是"这台机器现在跑的是什么"。
 */
export async function readEnvVersion(
  env: UpgradeEnvConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!env.portainerUrl || !env.apiKey || !env.stackId || !env.endpointId) return null;
  const base = env.portainerUrl.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/api/stacks/${env.stackId}?endpointId=${env.endpointId}`, {
      headers: { "x-api-key": env.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const stack = (await res.json()) as { Env?: { name: string; value: string }[] };
    return stack.Env?.find((e) => e.name === "KUAIBAN_VERSION")?.value ?? null;
  } catch {
    return null; // 读不到就说读不到，界面显示"未知"，不要瞎猜
  }
}

export interface UpgradeResult {
  ok: boolean;
  message: string;
}

/**
 * 触发一次升级。
 *
 * Portainer 的"更新堆栈"接口需要**完整的 compose 内容**，所以流程是：
 *   1. 先把当前堆栈读出来（拿到 compose 内容 + 现有环境变量）
 *   2. 把镜像那一项换成新版本
 *   3. 带着 `pullImage: true` 提交回去 → Portainer 拉新镜像并重建容器
 *
 * **数据在宿主机目录里（挂载），容器重建不会丢** —— 这是当初选挂载而不是
 * 命名卷的又一个理由。
 */
export async function applyUpgrade(opts: {
  env: UpgradeEnvConfig;
  version: string;
  imageName: string;
  fetchImpl?: typeof fetch;
}): Promise<UpgradeResult> {
  const { env } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  if (!env.portainerUrl || !env.apiKey || !env.stackId || !env.endpointId) {
    return { ok: false, message: "这个环境的 Portainer 配置还不完整（地址 / API Key / Stack ID / Endpoint ID）" };
  }

  const base = env.portainerUrl.replace(/\/+$/, "");
  const headers = { "x-api-key": env.apiKey, "content-type": "application/json" };
  const stackUrl = `${base}/api/stacks/${env.stackId}?endpointId=${env.endpointId}`;

  try {
    // 1) 读当前堆栈
    //
    // ⚠️ 注意这里要**两个**请求：
    // `/api/stacks/{id}` 只返回元数据，**不含 compose 内容**；
    // compose 内容要单独调 `/api/stacks/{id}/file`。
    // 一开始只调了前者，拿到空的 StackFileContent 就 PUT 回去，
    // Portainer 报 `400 Invalid request payload: Invalid stack file content`
    // —— 这个错只有在真实 Portainer 上才会暴露，单元测试的假 fetch 发现不了。
    const current = await doFetch(stackUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!current.ok) {
      return { ok: false, message: `读 Portainer 堆栈失败（HTTP ${current.status}）` };
    }
    const stack = (await current.json()) as {
      Env?: { name: string; value: string }[];
    };

    const fileRes = await doFetch(`${base}/api/stacks/${env.stackId}/file?endpointId=${env.endpointId}`, {
      headers,
      // 读配置也要给足时间：实测 Portainer 偶发几十秒才响应，
      // 原来给 15 秒会导致整个升级失败（而且报错写成"连不上"，误导排查方向）。
      signal: AbortSignal.timeout(60_000),
    });
    if (!fileRes.ok) {
      return { ok: false, message: `读堆栈的 compose 内容失败（HTTP ${fileRes.status}）` };
    }
    const file = (await fileRes.json()) as { StackFileContent?: string };
    const stackFileContent = file.StackFileContent ?? "";
    if (!stackFileContent.trim()) {
      return { ok: false, message: "Portainer 返回的 compose 内容是空的，为安全起见没有继续" };
    }

    // 2) 换镜像版本（已有该项就改，没有就加）
    const nextImage = `${opts.imageName}:${opts.version}`;
    const envList = [...(stack.Env ?? [])];
    const at = envList.findIndex((e) => e.name === env.imageVar);
    if (at >= 0) envList[at] = { name: env.imageVar, value: nextImage };
    else envList.push({ name: env.imageVar, value: nextImage });

    // 版本号变量也要跟着改 —— 它就是后台"当前版本"显示的那个值。
    // 只改镜像不改它的话，升完级界面还显示旧版本，看起来像没升成功。
    const vat = envList.findIndex((e) => e.name === "KUAIBAN_VERSION");
    if (vat >= 0) envList[vat] = { name: "KUAIBAN_VERSION", value: opts.version };
    else envList.push({ name: "KUAIBAN_VERSION", value: opts.version });

    // 3) 提交回去并让 Portainer 拉新镜像重建
    //
    // ⚠️ **这里刻意"发出去就不等返回"（fire-and-forget）**。
    //
    // 因为**服务器没法给自己做同步升级**：Portainer 的"更新堆栈"是同步接口，
    // 重建容器这件事是在请求过程中做的。如果后台所在的容器正是被升级的那个，
    // 请求还没返回、容器就死了 —— 升级流程中断，结果**什么都没发生**，
    // 界面上看起来就是一直停在"正在通知 Portainer…"。
    //
    // 发出去之后不去 await 响应体，接口就能立刻返回；Portainer 那边收到请求后
    // 继续把重建做完。（这与用户现有项目 bnoa 的做法一致。）
    //
    // 代价：拿不到 Portainer 的执行结果。所以"升级成没成功"要靠事后核对
    // （Stack 的 UpdateDate 变了没、容器重建没），不能只看这一句返回。
    const sent = doFetch(stackUrl, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        stackFileContent,
        env: envList,
        prune: false,
        pullImage: true,
      }),
    }).catch(() => null);

    // 只等一小会儿看它是否"当场被拒"（比如权限不对、参数非法）。
    // 等不到就认为请求已经发出去了 —— 对自我升级来说，"等不到"是正常现象。
    const quick = await Promise.race([
      sent,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);

    if (quick && !quick.ok) {
      const detail = await quick.text().catch(() => "");
      return { ok: false, message: `Portainer 拒绝了升级请求（HTTP ${quick.status}）${detail.slice(0, 200)}` };
    }

    return {
      ok: true,
      message: `已触发升级到 ${opts.version}，容器正在重建。数据在宿主机目录里，不会丢。若这是本机，页面可能短暂断开，属正常。`,
    };
  } catch (err) {
    // 错误要分类说清，不要一律写成"连不上"。
    // 之前正是因为把"等待超时"说成"连不上 Portainer"，才把人引去查网络
    // （而实测容器内部访问对面 Portainer 是 200 / 32ms，网络完全正常）。
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    const code = e.cause?.code ?? "";
    if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
      return { ok: false, message: "等 Portainer 响应超时。它可能正在忙，稍等片刻重试。" };
    }
    if (code === "ECONNREFUSED") {
      return { ok: false, message: "Portainer 拒绝连接（地址或端口不对，或服务没起来）。" };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { ok: false, message: "解析不到 Portainer 的主机名。" };
    }
    return { ok: false, message: `连不上 Portainer：${e.message ?? String(err)}` };
  }
}
