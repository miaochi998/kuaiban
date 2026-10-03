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

import { fetchLatestRelease } from "./github-releases.ts";
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
  /** 从哪个 GitHub Release 读版本号 */
  githubRepo: string;
  githubToken: string;
  envs: UpgradeEnvConfig[];
}

const SETTINGS_KEY = "upgrade_config";

/** 没配过时的默认骨架（地址按运维给的填好，Key 留空等管理员填） */
export function defaultUpgradeConfig(): UpgradeConfig {
  return {
    githubRepo: "",
    githubToken: "",
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

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  error: string | null;
}

/** 查有没有新版本（读 GitHub Release 的版本号） */
export async function checkServerUpdate(opts: {
  config: UpgradeConfig;
  currentVersion: string;
}): Promise<UpdateCheck> {
  const repo = opts.config.githubRepo || process.env.KUAIBAN_GITHUB_REPO || "";
  if (!repo) {
    return { current: opts.currentVersion, latest: null, hasUpdate: false, error: "还没有配置 GitHub 仓库" };
  }

  const release = await fetchLatestRelease({
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
    hasUpdate: release.version !== opts.currentVersion,
    error: null,
  };
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
    const current = await doFetch(stackUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!current.ok) {
      return { ok: false, message: `读 Portainer 堆栈失败（HTTP ${current.status}）` };
    }
    const stack = (await current.json()) as {
      StackFileContent?: string;
      Env?: { name: string; value: string }[];
    };

    // 2) 换镜像版本（已有该项就改，没有就加）
    const nextImage = `${opts.imageName}:${opts.version}`;
    const envList = [...(stack.Env ?? [])];
    const at = envList.findIndex((e) => e.name === env.imageVar);
    if (at >= 0) envList[at] = { name: env.imageVar, value: nextImage };
    else envList.push({ name: env.imageVar, value: nextImage });

    // 3) 提交回去并让 Portainer 拉新镜像重建
    const deploy = await doFetch(stackUrl, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        stackFileContent: stack.StackFileContent ?? "",
        env: envList,
        prune: false,
        pullImage: true,
      }),
    });

    if (!deploy.ok) {
      const detail = await deploy.text().catch(() => "");
      return { ok: false, message: `Portainer 拒绝了升级请求（HTTP ${deploy.status}）${detail.slice(0, 200)}` };
    }

    return {
      ok: true,
      message: `已触发升级到 ${opts.version}，容器正在重建。数据在宿主机目录里，不会丢。`,
    };
  } catch (err) {
    return { ok: false, message: `连不上 Portainer：${err instanceof Error ? err.message : String(err)}` };
  }
}
