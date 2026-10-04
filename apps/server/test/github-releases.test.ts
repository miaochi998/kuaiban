/**
 * GitHub Release → 下载页/更新清单的映射
 *
 * 这层错了的后果很具体：**给用户发错架构的安装包**（Intel 的包装到 Apple 芯片上
 * 直接打不开），或者自动更新指到一个不存在的地址。
 */

import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestRelease,
  fetchNewestRelease,
  hasClientAssets,
  macosArch,
  platformOf,
} from "../src/github-releases.ts";

describe("认识哪些安装包", () => {
  it("dmg / exe / msi / apk 都认得", () => {
    expect(platformOf("KuaiBan_0.1.1_aarch64.dmg")).toBe("macos");
    expect(platformOf("KuaiBan_0.1.1_x64-setup.exe")).toBe("windows");
    expect(platformOf("KuaiBan_0.1.1_x64_en-US.msi")).toBe("windows");
    expect(platformOf("KuaiBan_0.1.1.apk")).toBe("android");
  });

  it("签名文件和更新包不算安装包", () => {
    expect(platformOf("KuaiBan_0.1.1_aarch64.dmg.sig")).toBeNull();
    expect(platformOf("KuaiBan.app.tar.gz")).toBeNull();
  });
});

describe("macOS 芯片必须分对", () => {
  it("aarch64 → Apple 芯片；x64 → Intel", () => {
    expect(macosArch("KuaiBan_0.1.1_aarch64.dmg")).toBe("macos-arm64");
    expect(macosArch("KuaiBan_0.1.1_x64.dmg")).toBe("macos-intel");
    expect(macosArch("KuaiBan_0.1.1_x86_64.dmg")).toBe("macos-intel");
  });

  it("分不清就不猜 —— 装错芯片的包用户根本打不开", () => {
    expect(macosArch("KuaiBan_0.1.1.dmg")).toBeNull();
    expect(macosArch("KuaiBan_0.1.1_aarch64.exe")).toBeNull();
  });
});

describe("读 GitHub Release", () => {
  const okBody = {
    tag_name: "v0.1.2",
    published_at: "2026-10-04T00:00:00Z",
    body: "修了几个问题",
    assets: [
      { name: "KuaiBan_0.1.2_aarch64.dmg", browser_download_url: "https://x/a.dmg", size: 100 },
    ],
  };

  // GitHub 的 /releases 返回的是**数组**（原来用 /releases/latest 返回单个对象）。
  // 现在为了能"跳过不含客户端产物的空壳 Release"，改成了列表接口。
  function fakeFetch(body: unknown, status = 200) {
    const payload = Array.isArray(body) ? body : [body];
    return vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
  }

  it("正常读出来，版本号去掉 v 前缀", async () => {
    const release = await fetchLatestRelease({ repo: "me/kuaiban", fetchImpl: fakeFetch(okBody) });
    expect(release?.version).toBe("0.1.2");
    expect(release?.notes).toBe("修了几个问题");
    expect(release?.assets).toHaveLength(1);
  });

  it("网络出错返回 null，而不是抛异常把接口打挂", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchLatestRelease({ repo: "me/kuaiban", fetchImpl: boom })).toBeNull();
  });

  it("仓库没有 Release（404）也返回 null", async () => {
    const release = await fetchLatestRelease({
      repo: "me/kuaiban",
      fetchImpl: fakeFetch({ message: "Not Found" }, 404),
    });
    expect(release).toBeNull();
  });

  it("仓库名格式不对直接返回 null", async () => {
    expect(await fetchLatestRelease({ repo: "不是仓库名" })).toBeNull();
  });
});

describe("区分「客户端发布」与「服务端专用发布」", () => {
  const clientRelease = {
    tag_name: "v0.1.10",
    published_at: "2026-10-04T00:00:00Z",
    body: "",
    assets: [
      { name: "KuaiBan_0.1.10_aarch64.dmg", url: "https://api.github.com/a/1", browser_download_url: "x", size: 100 },
    ],
  };
  // 服务端专用发布：只建 Release 记版本，**不含客户端安装包**
  const serverOnlyRelease = {
    tag_name: "v0.1.11",
    published_at: "2026-10-05T00:00:00Z",
    body: "本次只发布服务端镜像",
    assets: [],
  };

  function fakeList() {
    // 最新的在前（GitHub 默认按发布时间倒序）
    return vi.fn(async () =>
      new Response(JSON.stringify([serverOnlyRelease, clientRelease]), { status: 200 }),
    ) as unknown as typeof fetch;
  }

  it("下载页/更新清单要跳过空壳 Release，取带客户端产物的那个", async () => {
    // 否则最新 Release 一变空壳，下载页和自动更新就全废了
    const r = await fetchLatestRelease({ repo: "me/kb", fetchImpl: fakeList() });
    expect(r?.version).toBe("0.1.10");
  });

  it("服务端版本检查要看到最新的那个（哪怕是空壳）", async () => {
    const r = await fetchNewestRelease({ repo: "me/kb", fetchImpl: fakeList() });
    expect(r?.version).toBe("0.1.11");
  });

  it("hasClientAssets 认得各种客户端产物", () => {
    expect(hasClientAssets([{ name: "KuaiBan_0.1.1_aarch64.dmg" }])).toBe(true);
    expect(hasClientAssets([{ name: "KuaiBan_0.1.1_x64-setup.exe" }])).toBe(true);
    expect(hasClientAssets([{ name: "KuaiBan_aarch64.app.tar.gz" }])).toBe(true);
    expect(hasClientAssets([{ name: "KuaiBan_aarch64.app.tar.gz.sig" }])).toBe(false);
    expect(hasClientAssets([])).toBe(false);
  });
});
