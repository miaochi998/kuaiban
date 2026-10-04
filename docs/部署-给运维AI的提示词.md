# 给服务器运维 AI 的提示词（可直接整段转发）

> 用法：把**下面分割线以内的全部内容**复制给你的服务器运维 AI。
> 它会把「需要回传的资料」和「需要它先做好的操作」一并办完再给你，
> 你再把结果发回给快办的开发 AI。

---

## 你的角色

你在为「快办（KuaiBan）」这个**公司内部待办工具**做生产环境部署。
它由三部分组成，全部由你负责的这套服务器设施承载：

1. **服务端**：一个 Node 程序，Docker 容器，由 Portainer 以 Stack 方式管理
2. **客户端**：桌面应用（macOS / Windows），未来还有安卓/鸿蒙/iOS
3. **对外访问**：员工通过 `https://kuaiban.bonnei.com` 访问

**已知的前置约束（请以此为准，不要推翻）**：

- 办公室 Debian 服务器，与运维机同局域网，装有 **Portainer**，**所有应用必须用 Portainer 的 Stack 方式部署**
- 已开通公网 IP，通过**路由器的动态域名 + 端口映射**对外
- **运营商封禁 80 和 443**，所以办公室这台**只能监听普通端口、只处理 HTTP**
- 真正的 HTTPS 与域名入口由**另一台阿里云服务器上的 NPM（Nginx Proxy Manager）** 承担
- 正式域名：**`kuaiban.bonnei.com`**
- 应用可使用端口段 **6520–6529**，目前方案只用 **6520** 一个端口

## 目标链路

```
员工浏览器 / 桌面客户端 / 手机
   │  https://kuaiban.bonnei.com            (443，无端口)
   ▼
阿里云服务器 · NPM (Nginx Proxy Manager)     ← 终止 HTTPS、管证书
   │  http://<办公室 DDNS 域名>:<映射端口>
   ▼
办公室路由器（端口映射）
   ▼
办公室 Debian 服务器 · Portainer
   └─ Stack: kuaiban
        └─ 容器监听 6520（HTTP）
             └─ 卷 /opt/kuaiban/data   ← 数据库 + 客户端安装包 + 签名私钥
```

## 任务一：请先完成这些操作（前置工作）

1. **确认服务器能访问 GitHub**
   这是本项目**关键依赖**：服务端要自己去 GitHub 取客户端安装包再转发给员工
   （员工的电脑连不上 GitHub，所以不能让他们直连）。
   请执行并记录结果：
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.github.com
   curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://objects.githubusercontent.com
   ```
   若不通，请说明现状与可行的替代（例如给 Docker/宿主配代理，或改用别的中转）。

2. **创建数据目录**
   ```bash
   sudo mkdir -p /opt/kuaiban/data/releases
   sudo chown -R 1000:1000 /opt/kuaiban/data   # 容器内 node 用户的 uid
   ls -ld /opt/kuaiban/data
   ```
   （这个目录要能容纳数据库、客户端安装包，请确认所在分区剩余空间 ≥ 20GB。）

3. **确认端口可用**
   ```bash
   ss -ltnp | grep -E ':6520\b' || echo "6520 空闲"
   ```
   并确认服务器本机防火墙（若有 ufw/nftables）放行 6520（**仅限内网来源**）。
   **不要**把 6520 直接暴露到公网 —— 公网入口统一走阿里云 NPM。

4. **路由器端口映射**
   把外网某个端口映射到 `办公室服务器局域网IP:6520`。
   建议映射到与内网不同的端口（例如外网 `16520` → 内网 `6520`），并记录实际使用的端口。
   若已有 DDNS 域名，请给出完整域名。

5. **阿里云 NPM 配置**（新增一个 Proxy Host）

   | 项 | 值 |
   |---|---|
   | Domain Names | `kuaiban.bonnei.com` |
   | Scheme | `http` |
   | Forward Hostname | 办公室的 DDNS 域名（或公网 IP） |
   | Forward Port | 上一步路由器映射的外网端口 |
   | Block Common Exploits | 开启 |
   | Websockets Support | 开启 |
   | SSL | 申请 Let's Encrypt 证书，开启 **Force SSL** |

   **并在 Advanced 里加上这一行**（否则员工下载客户端可能被截断）：
   ```nginx
   client_max_body_size 200m;
   ```

6. **域名解析**
   `kuaiban.bonnei.com` 的 A 记录指向**阿里云那台服务器的公网 IP**
   （不是办公室 IP —— 证书和入口都在阿里云）。
   请确认解析已生效：`dig +short kuaiban.bonnei.com`

7. **确认 Portainer 可用的部署方式**
   本项目提供一个 `docker-compose.yml`（Stack 定义）和一个 `Dockerfile`（服务端镜像）。
   请说明你们习惯的镜像流转方式，二选一并给出具体做法：
   - **A（推荐）**：在别处 `docker build` 后推到 **Docker Hub**（你们其他应用就是这么做的），
     Portainer 里 Stack 直接引用镜像地址
   - **B**：在 Portainer 里从 Git 仓库构建（私有仓库需要在 Portainer 里配好访问凭据）

## 任务二：请回传这些资料

请**按下表逐项填写**，能填的填、不能的说明原因。**不要贴任何密码、Token、私钥。**

| # | 需要的信息 | 你的填写 |
|---|---|---|
| 1 | 办公室服务器：局域网 IP、系统版本、Docker 版本、Portainer 版本 | |
| 2 | 服务器能否访问 GitHub（任务一第 1 步的结果） | |
| 3 | 服务器能否访问 Docker Hub（`docker pull hello-world` 是否成功） | |
| 4 | `/opt/kuaiban/data` 是否已建好、属主与所在分区剩余空间 | |
| 5 | 6520 是否空闲、防火墙是否已放行（仅内网） | |
| 6 | 路由器：外网映射端口是多少、DDNS 完整域名是什么 | |
| 7 | 阿里云 NPM：Proxy Host 是否已建好、证书是否已签发成功 | |
| 8 | `dig +short kuaiban.bonnei.com` 的结果 | |
| 9 | Portainer：该用哪个 **Endpoint ID**、准备使用的 **Stack 名称** | |
| 10 | 镜像流转方式选 A 还是 B；若 A，**Docker Hub 的命名空间/用户**是什么 | |
| 11 | 服务器上是否已有反向代理/防火墙规则会与 6520 冲突 | |
| 12 | 其他我应当知道的既有约定或限制 | |

> **第 9 项特别说明**：本项目计划在**管理后台里实现在线升级**（管理员点一下按钮
> 就能把服务端升到新版本），实现方式是由服务端调用 **Portainer API** 更新 Stack。
> 因此我需要：Portainer 的访问地址、该 Stack 的 ID、Endpoint ID。
> **这些属于敏感凭据，请不要贴在聊天里** —— 先告诉我"是否具备条件"，
> 真正填写的位置是快办管理后台的「系统升级」设置页（由我自己录入）。

## 任务二·补充：已确认的信息（2026-10-04）

以下已由运维确认，**无需再次回传**：

| 项 | 值 |
|---|---|
| 装有 Portainer 的机器 | 生产 `192.168.2.10:9000`（`prod-local`）／ 测试 `192.168.2.6:9000`（`testserver-local`） |
| Endpoint ID | 两台均为 **1** |
| Stack 名称 | 测试 `kuaiban-test` ／ 生产 `kuaiban-production` |
| Portainer 访问令牌 | 描述名 `kuaiban-upgrade`，永不过期（CE 不支持有效期），**已提供** |
| 端口 | **6522**（容器内仍监听 6520，映射 `6522:6520`） |
| 数据目录 | `/opt/kuaiban/data`（宿主机目录，不是命名卷） |
| DNS | `kuaiban.bonnei.com` → `47.105.64.102`（阿里云 NPM） |
| 测试机 | **仅局域网 IP 访问，不做端口映射、不需要域名** |

## 任务三：请确认这些"不要做"的事

请逐条确认（这是为了避免白做工或引入风险）：

1. **不要**把 6520 直接暴露到公网，也不要在这台机器上配置公网 HTTPS ——
   HTTPS 一律由阿里云 NPM 承担
2. **不要**改动服务器上已有的其他 Stack / 容器 / 数据库
3. **不要**把 `/opt/kuaiban/data` 放进任何自动清理策略
4. **不要**在聊天里回传密码、Token、私钥、证书私钥
5. 若发现方案中有与你们既有规范冲突的地方，**先说明冲突点**，不要擅自按你的方案改

## 交付格式

请按这个结构回复：

```
【前置工作完成情况】
1. GitHub 连通性：<命令输出>
2. 数据目录：<ls -ld 的输出>
3. 端口：<ss 的输出>
4. 路由器映射：外网端口 = ?，DDNS 域名 = ?
5. NPM：<截图或配置摘要，证书到期日>
6. DNS：<dig 结果>
7. 部署方式：A / B，以及具体做法

【需要的信息】
（照抄任务二的表格逐项填写）

【冲突与风险】
（有哪些与既有规范冲突、或你认为方案有问题的地方）

【我需要你（快办的开发者）确认的问题】
（如果有）
```

---

## 附：本项目会用到的环境变量（供你判断是否与既有规范冲突）

| 变量 | 用途 | 是否敏感 |
|---|---|---|
| `KUAIBAN_DB` | SQLite 数据库路径（容器内 `/data/kuaiban.db`） | 否 |
| `KUAIBAN_RELEASES_DIR` | 客户端安装包目录（容器内 `/data/releases`） | 否 |
| `KUAIBAN_PUBLIC_ORIGIN` | 对外域名，固定 `https://kuaiban.bonnei.com` | 否 |
| `KUAIBAN_GITHUB_REPO` | 客户端 Release 所在仓库（`owner/repo`） | 否 |
| `KUAIBAN_GITHUB_TOKEN` | 仅当该仓库为**私有**时需要，只读权限即可 | **是** |
| `KUAIBAN_ADMIN_PASSWORD` | 管理员初始密码，仅首次启动建号用 | **是** |
| `PORT` | 容器内监听端口，固定 `6520` | 否 |

敏感三项请在 Portainer 的 Stack 环境变量里填写，**不要**写进 compose 文件本身。
