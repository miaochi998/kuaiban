/**
 * 发布清单与下载的纯逻辑测试
 *
 * 这里最要紧的一件事：**下载接口不能被用来读发布目录以外的文件**。
 * （路径穿越是这类接口的经典漏洞，必须钉死。）
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ReleaseStore } from "../src/releases.ts";

let dir: string;
let store: ReleaseStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kuaiban-rel-"));
  store = new ReleaseStore({ dir, origin: "https://kuaiban.bonnei.com" });
});

function writeManifest(over: Record<string, unknown> = {}) {
  writeFileSync(
    join(dir, "releases.json"),
    JSON.stringify({
      version: "0.1.1",
      releasedAt: "2026-10-04T00:00:00.000Z",
      notes: "修了几个问题",
      downloads: { "macos-arm64": { file: "KuaiBan_0.1.1_aarch64.dmg" } },
      updates: {
        "darwin-aarch64": { file: "KuaiBan.app.tar.gz", signature: "签名内容" },
      },
      ...over,
    }),
  );
}

describe("下载页数据", () => {
  it("没发布清单时也返回全部平台槽位（页面显示「即将推出」，而不是报错）", () => {
    const listing = store.publicListing();

    expect(listing.version).toBeNull();
    // 六个平台槽位一个不少
    expect(listing.platforms.map((p) => p.key)).toEqual([
      "macos-arm64",
      "macos-intel",
      "windows",
      "android",
      "harmony",
      "ios",
    ]);
    expect(listing.platforms.every((p) => !p.available)).toBe(true);
  });

  it("清单里有、但文件不在服务器上 → 算作不可用", () => {
    writeManifest();
    const macos = store.publicListing().platforms.find((p) => p.key === "macos-arm64")!;
    expect(macos.available).toBe(false); // 文件还没传上去
  });

  it("文件就位后变成可下载，并给出绝对地址与大小", () => {
    writeManifest();
    writeFileSync(join(dir, "KuaiBan_0.1.1_aarch64.dmg"), Buffer.alloc(3 * 1024 * 1024));

    const macos = store.publicListing().platforms.find((p) => p.key === "macos-arm64")!;

    expect(macos.available).toBe(true);
    // 地址必须带上正式域名 —— 所有对外地址都从根域名拼
    expect(macos.url).toBe("https://kuaiban.bonnei.com/downloads/KuaiBan_0.1.1_aarch64.dmg");
    expect(macos.sizeLabel).toBe("3.0 MB");
  });

  it("清单文件坏掉时当作没发布，而不是把接口弄崩", () => {
    writeFileSync(join(dir, "releases.json"), "{这不是合法 JSON");
    expect(store.publicListing().version).toBeNull();
  });
});

describe("自动更新清单", () => {
  it("转成 Tauri 要求的格式，地址同样是绝对地址", () => {
    writeManifest();
    const manifest = store.updaterManifest()!;

    expect(manifest.version).toBe("0.1.1");
    expect(manifest.platforms["darwin-aarch64"]!.signature).toBe("签名内容");
    expect(manifest.platforms["darwin-aarch64"]!.url).toBe(
      "https://kuaiban.bonnei.com/downloads/KuaiBan.app.tar.gz",
    );
  });

  it("没有更新包时返回 null（服务端据此回 404）", () => {
    writeManifest({ updates: undefined });
    expect(store.updaterManifest()).toBeNull();
  });
});

describe("下载接口的安全边界", () => {
  it("正常文件名能解析到", () => {
    writeFileSync(join(dir, "a.dmg"), "x");
    expect(store.resolveFile("a.dmg")).not.toBeNull();
  });

  it("不允许用 ../ 跳出发布目录", () => {
    // 造一个"发布目录外面"的文件，确认读不到
    const outside = join(dir, "..", "secret.txt");
    writeFileSync(outside, "不该被读到");

    for (const evil of ["../secret.txt", "..%2Fsecret.txt", "a/../../secret.txt", "..\\secret.txt"]) {
      expect(store.resolveFile(evil), evil).toBeNull();
    }
  });

  it("不允许带路径分隔符", () => {
    expect(store.resolveFile("sub/a.dmg")).toBeNull();
    expect(store.resolveFile("/etc/passwd")).toBeNull();
  });
});
