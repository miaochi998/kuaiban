---
name: kuaiban-release
description: 快办（KuaiBan）发版与升级的标准流程 —— 客户端打 tag 自动构建并自动更新；服务端可独立发版（只推镜像、不惊动客户端），再在后台一键升级测试机与生产机。含环境约束、架构要点与全部已踩过的坑。
whenToUse: 当要给快办发布新版本（客户端或服务端）、升级服务器、或排查线上状态时使用。
---

# 快办发布 / 升级

> 部署架构已定型、**运维已退场**。日常发版升级完全自主，不需要运维参与。
> 只有基础设施级变更（防火墙 / 路由器 / 阿里云 NPM / 宿主机）才联系运维，且必须**提前说明、不要自行尝试**。

## 一、环境与地址

| | 测试机 | 生产机 |
|---|---|---|
| 内网 | `http://192.168.2.6:6522` | `http://192.168.2.10:6522` |
| Portainer | `http://192.168.2.6:9000` | `http://192.168.2.10:9000` |
| Stack 名 / ID | `kuaiban-test` / `5` | `kuaiban-production` / `5` |
| Endpoint ID | `1` | `1` |
| 数据目录 | `/opt/kuaiban/data` | `/opt/kuaiban/data` |

- **两机端口相同（都 6522），只能靠 IP 区分。改配置前先确认 IP。**
- 容器内监听 `6520`，映射 `6522:6520`。**内网 6520/6521 被 BNOA 占用** ⇒
  `KUAIBAN_PORT` 必须是 `6522`，**绝不能回落到 6520**（端口冲突、服务起不来）。
- **测试机不占外网入口**（只有内网可达）⇒ 怎么折腾都不影响员工。
- 外网：`https://kuaiban.bonnei.com` → 阿里云 NPM(id=13) → `ddns.bonnei.com:16523` → 爱快 → `.10:6522`。
- 镜像：Docker Hub `miaochi/kuaiban-server`（公开）。后台：`https://kuaiban.bonnei.com/admin`。
- **升级后台页面后必须刷新页面**才会看到新界面。

### 这台服务器能访问什么（决定方案可行性）

| 目标 | 可达 | 备注 |
|---|---|---|
| `api.github.com` | ✅ | 下载页 / 版本检查 / 回源都靠它 |
| `github.com` 直链 | ❌ 超时 | 必须走 API 通道 + `Accept: application/octet-stream` |
| `hub.docker.com` | ❌ | 直连 registry 超时，靠本机 4 个镜像加速器拉镜像 |

**推论：需要服务端直接访问境外服务的方案，必须在目标服务器上验证连通性** ——
曾据"开发机能读 Docker Hub"改成读镜像 tag，服务器读不到，方案作废。

---

## 二、两条独立的发版路径

### A. 发客户端（会推送给员工）

```bash
git add -A && git commit -m "..."
git push origin main
git tag v0.1.16          # 下个正式客户端版本从 v0.1.16 起（v0.1.14/0.1.15 已被"仅服务端"占用）
git push origin v0.1.16
```

CI 自动构建 macOS（Apple 芯片 / Intel）+ Windows → 签名 → 发 GitHub Release。
之后**什么都不用做**：下载页自动跟上、已装客户端自动更新。

### B. 只发服务端（**不惊动客户端**）

```bash
gh workflow run release-client.yml --repo miaochi998/kuaiban \
  -f version=0.1.16 -f server_only=true
```

结果：只构建推送镜像（客户端矩阵与"发 Release"两个 job 被 `skipped`），
并由 **CI 自己的步骤**建一个"仅服务端"Release 作为版本记录。

> 🔴 **绝不要手工 `gh release create`** 补建这种 Release —— 它用**个人凭据**建 tag，
> 会触发 `push: tags` 工作流、**跑一次完整构建**（已踩过）。
> CI 里用 `GITHUB_TOKEN` 建的 tag **不会**触发工作流，所以必须交给 CI。

---

## 三、后台一键升级

`https://kuaiban.bonnei.com/admin` → 「系统升级」。**每台机器一张卡片，各自显示自己的真实版本**
（不是"提供这个页面的服务器"的版本）：

```
┌─ 测试 ─────────────┐   ┌─ 正式 ─────────────┐
│ 0.1.15 当前运行版本 │   │ 0.1.13 当前运行版本 │
│ [可升级到 0.1.16]   │   │ [可升级到 0.1.16]   │
│ [升级到 0.1.16]     │   │ [升级到 0.1.16]     │
└────────────────────┘   └────────────────────┘
```

**先升「测试」→ 验证 → 再升「正式」。** 升级期间按钮禁用并显示实时进度；
**自我升级时页面会短暂断开，属正常**，界面会继续轮询直到确认结果。
版本相同时按钮变成「重新部署当前版本」（同机制、不改 tag，用于容器异常重启或同 tag 镜像被重推）。

**命令行兜底**：

```bash
# ⚠️ /stacks/{id} 不含 compose 内容，要单独调 /file
curl -sS -H "X-API-Key: $KEY" "http://192.168.2.6:9000/api/stacks/5/file?endpointId=1"
```

> 🔴 **PUT Stack 的 `env` 是【整体替换】不是合并** —— 必须带**完整清单**。
> 只发一部分会冲掉其它变量（曾把 `KUAIBAN_PORT` 冲掉 → 回落 6520 → 撞端口 →
> **测试机当场不可用**）。完整清单：
> `KUAIBAN_IMAGE` / `KUAIBAN_PORT=6522` / `KUAIBAN_VERSION` /
> `KUAIBAN_ADMIN_PASSWORD` / `KUAIBAN_PUBLIC_ORIGIN` /
> `KUAIBAN_GITHUB_REPO` / `KUAIBAN_GITHUB_TOKEN`

**Portainer 的 Stack 环境变量只用于 compose 变量替换** ——
compose 里没写 `${VAR}` 的地方变量不会进容器；新增服务端变量必须同时在
`deploy/docker-compose.yml` 的 `environment:` 里引用。

---

## 四、验证

```bash
curl -sS http://192.168.2.6:6522/api/health
curl -sS http://192.168.2.10:6522/api/health
curl -sS https://kuaiban.bonnei.com/api/health
curl -sS https://kuaiban.bonnei.com/api/releases | python3 -m json.tool | head -30
curl -sS https://kuaiban.bonnei.com/updates/latest.json | python3 -m json.tool

# 实际下载一次（同事的真实路径）
curl -sS -o /tmp/x.dmg -w '%{http_code} %{size_download} %{time_total}s\n' \
  https://kuaiban.bonnei.com/downloads/<文件名>

# 发完版立刻催预热（否则第一个下载的人要等 40 秒以上）
curl -sS -o /dev/null -X POST https://kuaiban.bonnei.com/api/refresh
# 测试机单独催：curl -sS -o /dev/null http://192.168.2.6:6522/api/releases
```

**判定"升级成功"不能只看界面** —— 三处一起看：
① 界面结果；② 目标 Stack 的 `UpdateDate` 是否变化；③ 容器 ID 与创建时间是否变化。

**更新包字节数对照**（一眼判断是否串版本）：`KuaiBan_aarch64.app.tar.gz` ——
0.1.1=3244564 ／ 0.1.2=3244508 ／ 0.1.3=3245018 ／ 0.1.4=3245329 ／
0.1.5=3245087 ／ 0.1.6=3245034 ／ 0.1.7=3245237。
**发新版后若看到旧值 = 缓存串版本复发**（见第五节 4）。

---

## 五、架构要点（改之前先理解）

1. **两种"最新"是分开的**（`apps/server/src/github-releases.ts`）：
   - `fetchLatestRelease` = 最新的、**含客户端产物的** Release（跳过空壳）→ 下载页 / `/updates/latest.json`
   - `fetchNewestRelease` = 最新的 Release（不论有无产物）→ **服务端版本检查**
   **不拆开，"只发服务端"会让最新 Release 变空壳、下载页与自动更新全废。**
2. **版本号必须逐段数值比较**：`"0.1.10" < "0.1.9"` 在字符串序下成立，会判反。
   用 `compareVersion()`；只用严格 `x.y.z` 参与比较（过滤 `latest`、日期、分支名）。
3. **读不到上游 ≠ 没有更新**：读失败要报明确失败态并走兜底，**不能返回空冒充"已是最新"**。
   同理**界面不知道的事就说不知道**（曾把 `latest === null` 显示成"已是最新"，骗过用户）。
4. **分发缓存必须带版本维度**：更新包**文件名跨版本重复**（0.1.1 与 0.1.2 都叫
   `KuaiBan_aarch64.app.tar.gz`）。曾先后踩两次：签名缓存串版本（客户端报
   `The update was signed for version X but the endpoint announced Y`）、
   安装包缓存串版本（`The signature verification failed`）。
   现：签名缓存按版本分目录；安装包每次刷新**按大小与 Release 声明比对，不一致就删**（自愈）。
5. **更新包必须带架构**：Tauri 打出的 macOS 更新包原名无架构信息（架构只在目录名上），
   CI 会重命名为 `KuaiBan_aarch64.app.tar.gz` / `KuaiBan_x64.app.tar.gz`。**分不清就不发** ——
   发错芯片的包用户打不开。
6. **缓存预热**：服务端发现新版本后后台拉安装包。触发两条：服务端 5 分钟定时器 +
   CI 发版后调 `POST /api/refresh`。否则第一个下载的人要等服务器从 GitHub 取完。

---

## 六、客户端（Tauri）侧的坑

- **浮动挂件里不能用 `window.confirm` / `alert`**：快办是 `ActivationPolicy::Accessory`
  的非激活面板，**系统模态框弹不出来**，`confirm()` 直接返回 false，表现为"点了没反应"。
  **一律用界面内确认。**
- **凡"改数据"的功能，测试要盯住最容易假成功的地方**（"只清了界面没清存储""失败却返回成功"）——
  缺这类测试，缺陷会直接漏到用户手上。
- **登出/切换账号要清掉会话态**（曾出现登出后仍显示"待办属于另一个账号"）。
- **`plaintextCodec.decode` 只解析不校验** ⇒ `decodePull` 做必填字段校验，
  坏记录进 `broken` 并跳过（**不能让个别坏数据拖垮整次同步**），可选字段缺失给默认值。
- **界面不知情时不得用默认值冒充结论**；耗时操作要立刻禁用按钮并给持续变化的进度；
  **"预期内的中断"要预先说明**（自我升级时页面断开属正常）。

---

## 七、CI / 脚本铁律（都真踩过）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `pnpm/action-setup` 与 `package.json` 同时指定版本 | `Multiple versions of pnpm specified` | 只留 `packageManager` 一个来源 |
| `macos-13` runner 已退役 | job **永远 queued**（像"在跑"） | 用 `macos-15-intel` |
| `sed "0,/^x = /s//x = \"v\"/"` | `s//repl/` 只替换前缀、旧值残留 → TOML 解析失败 | 用 `node` 改配置 |
| `[ -z "$x" ] && x=y` | 条件为假时返回 1，被 `set -e` 终止 | 用 `if` 或 `${x:-default}` |
| **node 脚本内联在 YAML 的 `run:`** | 三层转义把 `\d` 变 `\\d`，三平台全挂 | **脚本放独立文件**，`run: node scripts/xxx.mjs` |
| `download-artifact` 未过滤 | 把 `*.dockerbuild` 缓存产物当发布产物下载 → 解压失败 | 加 `pattern: bundle-*` |
| **python 字符串替换未 assert** | 锚点不匹配时 `.replace()` **静默不生效却打印 OK** | **`assert old in s`**，改完**解析/读取核对** |
| **手工 `gh release create`** | 个人凭据建 tag → 触发完整构建 | 交给 CI（GITHUB_TOKEN 建的 tag 不触发） |

- **`queued` 超过几分钟 = runner 标签失效或额度不足**，不是"在排队"。
- **CI 报错文案会误导**（"Artifact download failed" 实为"下载了不该下载的产物"）：
  **先读日志再决定是否重跑；重跑仍失败必须立刻查日志。**
- **改了 workflow 后只重跑旧 run 没用**（沿用原提交的脚本）——要让修复生效必须让 tag/分支指向新提交；
  **tag 若仍指向同一提交，GitHub 不会触发新 run**。

---

## 八、排查

```bash
gh run list --repo miaochi998/kuaiban --limit 6
# event 与 ref 能立刻定位是谁触发的（曾靠它查出"完整编译"是手工建 tag 导致）
gh run list --repo miaochi998/kuaiban --limit 3 --json databaseId,event,headBranch,status,conclusion
gh run cancel <id>

# 失败在哪一步（run 未结束时拿不到日志）
gh run view <id> --repo miaochi998/kuaiban --json jobs \
  -q '.jobs[] | "\(.name): \(.conclusion) ← \(.steps[] | select(.conclusion=="failure") | .name)"'

# 容器状态与日志（Portainer API）
curl -sS -H "X-API-Key: $KEY" "http://<host>:9000/api/endpoints/1/docker/containers/json?all=1"
curl -sS -H "X-API-Key: $KEY" "http://<host>:9000/api/endpoints/1/docker/containers/<id>/logs?stdout=1&stderr=1&tail=30"
```

**域名指向验证（硬办法）**：把测试机容器临时停数十秒，观察域名是否仍正常 ——
仍正常即证明域名与测试机无关（运维用过此法）。**用完立即恢复。**
（区分两台的简易法：测试机有账号 `ceshi`，生产机只有 `admin`。）

---

## 九、测试纪律

- **红灯不提交、不发版。**顺序固定：**看失败 → 查清原因 → 再提交**。（犯过两次。）
- **涉及"今天"的断言必须按业务日规则算**（业务日边界 **04:00**），禁止直接用 `new Date()` ——
  用 `todayWeekdayCn()`。已两次因日期依赖在特定时间点挂掉（「每周六」；凌晨业务日与自然日差一天）。
- 提交前本地跑：`pnpm typecheck && pnpm test && pnpm exec playwright test`。
  **CI/shell 里的逻辑提交前必须本地跑一遍** —— 历史上三次 CI 失败，根因全是胶水代码。
- **验证必须走被测的那条路径**，不能用等价的手工操作代替（曾用手工建的 Release
  代替 CI 步骤去"验证"，等于没验）。

---

## 十、运维边界

**不需要运维**：发版（客户端/服务端）、升测试机、升生产机、客户端自动更新、
下载页更新、证书续期、每日备份。

**需要运维（提前说明，不要自行尝试）**：防火墙规则、路由器映射、
阿里云 NPM / 证书异常、宿主机故障与磁盘、Docker / Portainer 本身、新增外网入口。

**备份**：`/opt/kuaiban/data` 已纳入运维每日备份（测试机 23:30 / 生产机 02:00），
且已做 SQLite 一致性加固（备份前 `VACUUM INTO` 原子快照）。
内含 `kuaiban.db` 与 `releases/`（安装包缓存，可再生）。
**更新签名私钥不在服务器上**（签名在 CI 完成），私钥只在 GitHub Secrets 与离线副本各一份。
