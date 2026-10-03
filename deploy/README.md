# 快办 · 生产部署

## 整条链路

```
   员工电脑 / 手机
        │  https://kuaiban.bonnei.com   (443，无端口)
        ▼
   阿里云服务器 · NPM (Nginx Proxy Manager)
        │  终止 HTTPS，反代到 ↓
        │  http://<办公室动态域名>:8787
        ▼
   办公室路由器（端口映射；运营商封 80/443，所以用非标端口）
        ▼
   办公室 Debian 服务器 · Portainer 堆栈
        └─ kuaiban 容器（本目录的 docker-compose.yml）
             └─ /opt/kuaiban/data  ← 数据库 + 发布包 + 签名密钥
```

**要点**：办公室这台**只监听普通端口、只处理 HTTP**。
HTTPS、证书、域名解析全在阿里云那台 NPM 上 —— 一条链路只有一个地方管证书，
少一个出错的地方。

## 一、构建镜像

在**有 Docker 的机器**上（办公室服务器自己也行）：

```bash
git clone <本仓库> && cd KUAIBAN
docker build -f apps/server/Dockerfile -t kuaiban-server:0.1.1 .
```

> 也可以在 Portainer 里用 "Build from Git repository" 直接构建（私有仓库需要在
> Portainer 里配好凭据）。**推荐推到镜像仓库**（阿里云容器镜像服务 ACR 最顺），
> 服务器只负责拉取 —— 构建和运行分开，服务器上不用留源码。

推仓库：

```bash
docker tag kuaiban-server:0.1.1 registry.cn-hangzhou.aliyuncs.com/你的命名空间/kuaiban-server:0.1.1
docker push registry.cn-hangzhou.aliyuncs.com/你的命名空间/kuaiban-server:0.1.1
```

## 二、在 Portainer 里部署堆栈

Stacks → **Add stack** → 名称 `kuaiban` → 粘贴 `docker-compose.yml` 的内容。

环境变量（Environment variables 区）：

| 变量 | 说明 |
|---|---|
| `KUAIBAN_IMAGE` | 上面构建/推送的镜像地址 |
| `KUAIBAN_PORT` | 局域网监听端口，默认 `8787`（要和路由器端口映射一致） |
| `KUAIBAN_ADMIN_PASSWORD` | 管理员初始密码，**至少 8 位**。只在第一次启动建号时用 |

先把数据目录建好：

```bash
sudo mkdir -p /opt/kuaiban/data/releases
```

然后 Deploy。

## 三、看一眼装好了没

```bash
curl http://127.0.0.1:8787/api/health
# → {"ok":true}
```

浏览器打开 `http://<服务器局域网IP>:8787/` 应该看到**发布下载页**，
`http://<服务器局域网IP>:8787/admin` 是管理后台。

## 四、路由器 + 阿里云 NPM

1. **路由器**：把外网某个端口（例如 `18787`）映射到 `办公室服务器IP:8787`
2. **动态域名**：路由器自带 DDNS，得到一个形如 `xxx.f3322.net` 的域名
3. **阿里云 NPM**：新增 Proxy Host
   - Domain Names：`kuaiban.bonnei.com`
   - Scheme：`http`
   - Forward Hostname：`xxx.f3322.net`（或直接填办公室公网 IP）
   - Forward Port：`18787`
   - 勾上 **Block Common Exploits**、**Websockets Support**
   - SSL 页：申请 Let's Encrypt 证书，勾 **Force SSL**
4. **域名解析**：`kuaiban.bonnei.com` 的 A 记录指向**阿里云那台服务器的公网 IP**
   （不是办公室 IP —— 因为证书和入口都在阿里云）

> ⚠️ **NPM 里要放开上传体积**：安装包有 3～6 MB，默认限制可能不够。
> 在 Advanced 页加 `client_max_body_size 200m;`。
> （下载不走反代也行，但既然统一入口，一次配好省事。）

## 五、发版（以后每次更新）

在**开发机**上：

```bash
node scripts/release.mjs 0.1.2
```

它会打包、签名、把安装包和更新包复制到本机发布目录、写好清单。

然后把发布目录同步到服务器：

```bash
rsync -av --delete \
  "$HOME/Library/Application Support/com.kuaiban.server/releases/" \
  root@<办公室服务器>:/opt/kuaiban/data/releases/
```

**传完就结束了** —— 下载页和自动更新清单都是**每次请求实时读清单**的，
不需要重启容器、更不需要手动改页面。

## 六、数据与备份（最重要的一条）

**要备份的只有一个目录：`/opt/kuaiban/data`**

```
/opt/kuaiban/data/
  ├── kuaiban.db                 ← 所有人的待办
  ├── kuaiban.db-wal             ← SQLite 的预写日志（一起备）
  ├── releases/                  ← 安装包与更新清单
  └── kuaiban-updater.key        ← 更新签名私钥
```

```bash
# 每天凌晨 3 点打包一次，保留 30 天
0 3 * * * tar czf /opt/kuaiban/backup/kuaiban-$(date +\%F).tar.gz -C /opt/kuaiban data && \
          find /opt/kuaiban/backup -name '*.tar.gz' -mtime +30 -delete
```

> **私钥也在这个目录里，是刻意的** —— 你本来就必须备份数据，
> 让它搭同一趟车，就不存在"还要额外记住一个文件"这件事。

## 七、更新（升级服务端自己）

改 `KUAIBAN_IMAGE` 里的 tag → Portainer 里点 **Update the stack**（勾上重新拉取镜像）。
数据在宿主机目录里，容器重建不会丢。
