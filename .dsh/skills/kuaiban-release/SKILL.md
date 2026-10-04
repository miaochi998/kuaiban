---
name: kuaiban-release
description: 快办（KuaiBan）发版与服务端升级的标准流程 —— 客户端打 tag 触发 CI 自动构建并自动更新，服务端构建镜像后先在测试机验证、再升生产机。含验证清单与本项目已踩过的所有坑。
whenToUse: 当要给快办发布新版本、升级服务端、或需要确认线上状态时使用。
---

# 快办发布 / 升级

> **背景**：部署架构已经定型，运维已退场。**日常发版升级完全由我们自主完成，不需要运维参与。**
> 只有基础设施级变更（防火墙 / 路由器映射 / 阿里云 NPM / 宿主机）才需要联系运维，且必须**提前说明需求、不要自行尝试**。

## 环境与地址（改任何东西前先确认目标）

| | 测试机 | 生产机 |
|---|---|---|
| 内网地址 | `http://192.168.2.6:6522` | `http://192.168.2.10:6522` |
| Portainer | `http://192.168.2.6:9000` | `http://192.168.2.10:9000` |
| Stack 名 | `kuaiban-test` | `kuaiban-production` |
| Stack ID | `5` | `5` |
| Endpoint ID | `1` | `1` |
| 数据目录 | `/opt/kuaiban/data` | `/opt/kuaiban/data` |

- **两机端口完全相同（都是 6522），只能靠 IP 区分。改配置前务必确认 IP。**
- **测试机不占外网入口**，只有内网可达 → 怎么折腾都不会影响员工。
- 外网入口 `https://kuaiban.bonnei.com` → 阿里云 NPM(id=13) → `ddns.bonnei.com:16523` → 爱快 → `.10:6522`。
- 镜像：Docker Hub `miaochi/kuaiban-server`（公开）。

**端口映射与防火墙由运维维护，不要改动。**

---

## 一、发客户端新版本（最常见）

客户端地址是**打包时烧死的**（`apps/desktop/src/lib/endpoints.ts` 的 `PRODUCTION_ORIGIN`），
所以发版只需打 tag，其余全自动。

```bash
# 1) 改版本号（tauri.conf.json 与 Cargo.toml 由 CI 自动同步，本地改不改都行）
# 2) 提交
git add -A && git commit -m "..."
git push origin main

# 3) 打 tag 触发构建
git tag v0.2.0
git push origin v0.2.0

# 4) 看构建（约 18 分钟）
gh run list --repo miaochi998/kuaiban --limit 1
gh run watch --repo miaochi998/kuaiban
```

CI 会自动：构建 macOS（Apple 芯片 / Intel）+ Windows → 签名 → 发 GitHub Release。

**然后什么都不用做**：

- 服务端自动跟随 Release → **下载页自动更新**
- 已装客户端自动更新

> 失败时重跑：`gh workflow run release-client.yml --repo miaochi998/kuaiban -f version=0.2.0`

### ★ 发完立刻"催"一次缓存预热（重要，否则第一个下载的人要等）

服务端发现新版本后会**在后台把安装包拉到本地**，但预热是在它**下一次去问 GitHub** 时
才启动的（结果缓存 5 分钟）。所以发布后如果没人访问，预热就不会开始 ——
这期间第一个点下载的同事要等服务器从 GitHub 取完（实测 3.2MB 要 60 秒以上）。

**打一次 `/api/releases` 就能立刻触发预热**：

```bash
curl -sS -o /dev/null https://kuaiban.bonnei.com/api/releases
# 等 2~3 分钟让后台拉完，然后下载就是本地直读（毫秒级）
```

（同一个域名也会触发测试机那一侧？不会 —— 域名只指生产机。测试机需要时，
用 `curl -sS -o /dev/null http://192.168.2.6:6522/api/releases` 单独催一次。）

### 验证（必做）

```bash
curl -sS https://kuaiban.bonnei.com/api/releases | python3 -m json.tool | head -30
# 版本号应为新版本，各平台 available=true

curl -sS https://kuaiban.bonnei.com/updates/latest.json | python3 -m json.tool
# platforms 里 darwin-aarch64 / darwin-x86_64 都应有 signature

# 外网真实下载一次（这才是同事的真实路径）
curl -sS -o /tmp/x.dmg -w '%{http_code} %{size_download} %{time_total}s\n' \
  https://kuaiban.bonnei.com/downloads/<新文件名>.dmg
```

---

## 二、升级服务端（先测试机，再生产机）

```bash
# 1) 本地验证（**必做**，见「铁律」）
pnpm typecheck && pnpm test

# 2) 构建 linux/amd64 镜像 —— 服务器是 x86_64，开发机是 Apple 芯片，必须交叉构建
docker build --platform linux/amd64 -f apps/server/Dockerfile \
  -t miaochi/kuaiban-server:0.2.0 . 
docker push miaochi/kuaiban-server:0.2.0
docker tag miaochi/kuaiban-server:0.2.0 miaochi/kuaiban-server:latest
docker push miaochi/kuaiban-server:latest
```

### 3) 先升测试机

**首选**：在快办管理后台「系统升级」页选「测试」→ 填版本号 → 开始升级。
（后台地址：`https://kuaiban.bonnei.com/admin`，域名指生产机时用 `http://192.168.2.6:6522/admin` 升测试机）

**或者直接调 Portainer API**（后台升级功能异常时的兜底）：

```bash
# 取 Stack 当前 compose 内容 —— 注意必须调 /file，/stacks/{id} 不含内容
curl -sS -H "X-API-Key: $KEY" \
  "http://192.168.2.6:9000/api/stacks/5/file?endpointId=1"

# 更新（body: {stackFileContent, env:[...], prune:false, pullImage:true}）
curl -sS -X PUT -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  "http://192.168.2.6:9000/api/stacks/5?endpointId=1" --data-binary @body.json
```

**验证测试机**（内网直连，不需要客户端）：

```bash
curl -sS http://192.168.2.6:6522/api/health          # {"ok":true}
curl -sS http://192.168.2.6:6522/api/releases | head -c 200
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.2.6:6522/
```

功能相关改动要**真的用一次**再上生产（建待办、同步、看界面）。

### 4) 测试没问题，再升生产机

同样方式，把目标换成 `192.168.2.10` / Stack `kuaiban-production`。

### 5) 验证生产

```bash
curl -sS https://kuaiban.bonnei.com/api/health
curl -sS https://kuaiban.bonnei.com/api/releases | head -c 200
curl -sS -o /dev/null -w '%{http_code}\n' https://kuaiban.bonnei.com/
```

---

## 三、铁律（都是本项目真踩过的）

### 1. CI / shell 里的逻辑，提交前必须本地跑一遍

本项目 CI 连续失败三次，根因**没有一个是业务逻辑**，全是胶水代码：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `pnpm/action-setup` 与 `package.json` 同时指定版本 | 立刻失败 `Multiple versions of pnpm specified` | 只留 `packageManager` 一个来源 |
| `macos-13` runner 已退役 | job **永远 queued**（看着像"在跑"） | 用 `macos-15-intel` |
| `sed "0,/^x = /s//x = \"v\"/"` | `s//repl/` 只替换前缀、旧值残留 → TOML 解析失败 | 用 `node` 改配置 |
| `[ -z "$x" ] && x=y` | 条件为假时返回 1，被 `set -e` 终止 | 用 `if` 或 `${x:-default}` |
| **node 脚本内联在 YAML 的 `run:` 里** | 三层转义把 `\d` 变成 `\\d`，**三平台全挂** | **脚本放独立文件**，`run: node scripts/xxx.mjs` |

**GitHub Actions 里 `queued` 超过几分钟 = runner 标签失效或额度不足，不是"在排队"。**

### 2. Portainer 相关的坑

- **`GET /api/stacks/{id}` 只返回元数据，不含 compose 内容** → 必须调
  **`GET /api/stacks/{id}/file?endpointId=`**。用空内容 PUT 会得到
  `400 Invalid request payload: Invalid stack file content`。
- 创建 Stack 在 2.27 是 **`POST /api/stacks/create/standalone/string?endpointId=`**；
  老的 `POST /api/stacks?type=2` 返回 **405**。
- **创建容器不会自动拉镜像**（报 `No such image`）→ 要选目标主机上已有的镜像。
- **Portainer 的 Stack 环境变量只用于 compose 变量替换**：compose 里没写 `${VAR}` 的地方，
  变量**不会进容器**。新增任何服务端环境变量，必须同时在 `deploy/docker-compose.yml`
  的 `environment:` 里显式引用。
- **`docker build` 一定要带 `--platform linux/amd64`**（服务器是 x86_64）。
- 不要改 Stack 名 / 容器名（虽然数据在宿主机目录、改名不丢，但运维明确要求不要改）。

### 3. 对接外部 API 时，测试替身必须照抄真实响应结构

升级功能的单元测试全绿，真机上照样 400 —— 因为假 fetch 把 compose 内容塞进了
真实响应里根本没有的字段。**"只有真环境才暴露"的 bug，几乎都是替身比真实对象更宽容造成的。**
空内容 / 空响应时，**破坏性操作必须硬拒绝**（拿不到 compose 就报错，不要盲改）。

### 4. 下载分发

- **对外地址一律用自有域名，绝不直连 GitHub**（同事电脑连不上）。
  服务端作为分发点回源取回并缓存。
- **回源必须走 API 通道**：`GET api.github.com/repos/<o>/<r>/releases/assets/<id>`
  ＋ `Accept: application/octet-stream`（`github.com` 直链在国内超时）。
- **必须有缓存预热**：发现新版本后后台把所有安装包拉到本地。否则第一个下载的人要等
  服务器从 GitHub 取完（实测 3.2MB 要 111 秒，大文件直接超时）。
  预热后是本地直读（0.017 秒）。
- **macOS 架构绝不能猜**：更新包文件名必须带 `aarch64`/`x64`（CI 会重命名），
  分不清就**不发** —— 发错芯片的包用户打不开。

### 5. 其他

- **验证脚本里不要反复调登录接口**（会触发限频把自己挡住）。多次鉴权请复用同一个 token。
- **`gh` CLI 已登录 `miaochi998`**，可以直接代用户操作 GitHub
  （设 Secrets、看/重跑 CI、看 Release）。给 GitHub 设 Secrets 时用
  `gh secret set <名> --repo miaochi998/kuaiban < <文件路径>`，内容不经聊天。
- **多行或含引号的 git 提交消息用 heredoc**：
  `git commit -F - <<'EOF' … EOF`（用 `-m "…"` 会因引号破坏而报
  `pathspec ... did not match any file(s)`）。
- **凭据不入库**：`apps/server/.env.local` 已被 gitignore。
  Portainer API Key 与 GitHub token 都存在**服务端数据库**里（管理后台可配），
  不在 compose、不在代码。
- 服务端 `KUAIBAN_GITHUB_TOKEN` 或 `KUAIBAN_GITHUB_REPO` 失效时**下载页会静默空掉** ——
  排查时先看 `/api/releases` 的 `version` 是否为空，再确认 token 有效性
  （判定法：同 token 在本机与容器内都 401、而 `gh` 正常 ⇒ 凭据失效）。

---

## 四、常用排查

```bash
# 服务端状态
curl -sS http://192.168.2.6:6522/api/health
curl -sS http://192.168.2.10:6522/api/health
curl -sS https://kuaiban.bonnei.com/api/health

# 域名指向哪台？（两台数据库内容不同，可用账号列表区分）
#   测试机有账号 ceshi、生产机只有 admin

# 容器状态与日志（用 Portainer API）
KEY=<测试机或生产机的 API Key>
curl -sS -H "X-API-Key: $KEY" "http://<host>:9000/api/endpoints/1/docker/containers/json?all=1"
curl -sS -H "X-API-Key: $KEY" "http://<host>:9000/api/endpoints/1/docker/containers/<id>/logs?stdout=1&stderr=1&tail=30"

# 检查更新
curl -sS -X POST https://kuaiban.bonnei.com/api/admin/upgrade/check \
  -H "authorization: Bearer <管理员 token>"
```

## 五、运维边界

**不需要运维**：发版、升测试机、升生产机、客户端自动更新、下载页更新、证书续期、每日备份。

**需要运维（提前说明需求，不要自行尝试）**：防火墙规则、路由器映射、阿里云 NPM / 证书异常、
宿主机故障与磁盘、Docker / Portainer 本身的问题、新增外网入口。

**备份**：`/opt/kuaiban/data` 已纳入运维每日备份（测试机 23:30 / 生产机 02:00），
且已做 SQLite 一致性加固（备份前用 `VACUUM INTO` 生成原子快照）。
里面有 `kuaiban.db` 与 `releases/`（安装包缓存，可再生）。
**更新签名私钥不在服务器上**（签名在 CI 完成），私钥只在 GitHub Secrets 与离线副本各一份。
