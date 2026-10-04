/**
 * 在线升级
 *
 * 这里最要紧的两条：
 * 1. **API Key 绝不能回显到浏览器**（Portainer CE 的 Key 等同管理员权限）
 * 2. 提交给 Portainer 的请求里，**镜像那一项真的被换成了新版本**
 *    （改错了就是"以为升级了其实没升"）
 */

import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.ts";
import { Store } from "../src/store.ts";
import {
  applyUpgrade,
  checkServerUpdate,
  defaultUpgradeConfig,
  loadUpgradeConfig,
  publicUpgradeConfig,
  saveUpgradeConfig,
  type UpgradeEnvConfig,
} from "../src/upgrade.ts";

function makeStore() {
  return new Store(openDatabase(":memory:"));
}

const env: UpgradeEnvConfig = {
  key: "test",
  label: "测试",
  portainerUrl: "http://192.168.2.6:9000",
  apiKey: "ptr_secret_key",
  stackId: "7",
  endpointId: "1",
  imageVar: "KUAIBAN_IMAGE",
};

describe("配置的存取", () => {
  it("没配过时给默认骨架，两台 Portainer 地址预先填好", () => {
    const config = loadUpgradeConfig(makeStore());
    expect(config.envs.map((e) => e.portainerUrl)).toEqual([
      "http://192.168.2.6:9000",
      "http://192.168.2.10:9000",
    ]);
    // Key 必须空着等管理员填，不能有默认值
    expect(config.envs.every((e) => e.apiKey === "")).toBe(true);
  });

  it("存了能读回来", () => {
    const store = makeStore();
    saveUpgradeConfig(store, { ...defaultUpgradeConfig(), githubRepo: "miaochi998/kuaiban" });
    expect(loadUpgradeConfig(store).githubRepo).toBe("miaochi998/kuaiban");
  });

  it("配置坏掉时退回默认，而不是把服务端搞挂", () => {
    const store = makeStore();
    store.setSetting("upgrade_config", "{这不是 JSON");
    expect(loadUpgradeConfig(store).envs).toHaveLength(2);
  });
});

describe("API Key 绝不回显", () => {
  it("给界面的形态里只有「配没配」，没有 Key 本身", () => {
    const config = defaultUpgradeConfig();
    config.envs[0]!.apiKey = "ptr_super_secret";

    const shown = publicUpgradeConfig(config) as {
      envs: { hasApiKey: boolean }[];
      hasGithubToken: boolean;
    };

    expect(shown.envs[0]!.hasApiKey).toBe(true);
    // 整个回给浏览器的对象里不许出现 Key 的字样
    expect(JSON.stringify(shown)).not.toContain("ptr_super_secret");
  });
});

describe("检查更新", () => {
  it("没配仓库时给一句人话，而不是报错", async () => {
    const result = await checkServerUpdate({
      config: { ...defaultUpgradeConfig(), githubRepo: "" },
      currentVersion: "0.1.1",
    });
    expect(result.error).toContain("GitHub");
    expect(result.hasUpdate).toBe(false);
  });

});

describe("触发升级", () => {
  it("把镜像那一项换成新版本，并要求 Portainer 重新拉镜像", async () => {
    let putBody: Record<string, unknown> | null = null;

    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        // compose 内容要单独从 /file 拿（Portainer 的 /stacks/{id} 不含它）
        if (String(url).includes("/file")) {
          return new Response(
            JSON.stringify({ StackFileContent: "services:\n  kuaiban:\n    image: ${KUAIBAN_IMAGE}\n" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            Env: [
              { name: "KUAIBAN_PORT", value: "6522" },
              { name: "KUAIBAN_IMAGE", value: "miaochi/kuaiban-server:0.1.1" },
            ],
          }),
          { status: 200 },
        );
      }
      putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await applyUpgrade({
      env,
      version: "0.1.2",
      imageName: "miaochi/kuaiban-server",
      fetchImpl: fakeFetch,
    });

    expect(result.ok).toBe(true);

    // 关键断言：镜像版本被换掉了、其他环境变量原样保留、要求重新拉镜像
    const sentEnv = putBody!.env as { name: string; value: string }[];
    expect(sentEnv.find((e) => e.name === "KUAIBAN_IMAGE")!.value).toBe("miaochi/kuaiban-server:0.1.2");
    expect(sentEnv.find((e) => e.name === "KUAIBAN_PORT")!.value).toBe("6522");
    expect(putBody!.pullImage).toBe(true);
  });

  it("原来没有镜像这一项时会加进去", async () => {
    let putBody: Record<string, unknown> | null = null;
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        if (String(url).includes("/file")) {
          return new Response(JSON.stringify({ StackFileContent: "services: {}" }), { status: 200 });
        }
        return new Response(JSON.stringify({ Env: [] }), { status: 200 });
      }
      putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await applyUpgrade({ env, version: "0.1.2", imageName: "miaochi/kuaiban-server", fetchImpl: fakeFetch });

    const sentEnv = putBody!.env as { name: string; value: string }[];
    expect(sentEnv).toEqual([{ name: "KUAIBAN_IMAGE", value: "miaochi/kuaiban-server:0.1.2" }]);
  });

  it("拿不到 compose 内容时必须拒绝 —— 盲改会把堆栈写坏", async () => {
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        if (String(url).includes("/file")) {
          return new Response(JSON.stringify({ StackFileContent: "" }), { status: 200 });
        }
        return new Response(JSON.stringify({ Env: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await applyUpgrade({ env, version: "0.1.2", imageName: "x/y", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("空的");
  });

  it("配置不全时明确拒绝，不去瞎试", async () => {
    const result = await applyUpgrade({
      env: { ...env, apiKey: "" },
      version: "0.1.2",
      imageName: "x/y",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("配置还不完整");
  });

  it("Portainer 报错时把状态码带回来，而不是静默失败", async () => {
    const fakeFetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    const result = await applyUpgrade({
      env,
      version: "0.1.2",
      imageName: "x/y",
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
  });

  it("连不上 Portainer 时给可读提示，不抛异常", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await applyUpgrade({ env, version: "0.1.2", imageName: "x/y", fetchImpl: boom });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("连不上 Portainer");
  });
});
