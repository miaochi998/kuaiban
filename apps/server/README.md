# 快办服务端

给「快办」桌面挂件提供**账号**与**多设备同步**。零第三方运行时依赖
（`node:http` + `node:sqlite` + `node:crypto`），一个文件一个进程，好部署。

## 跑起来

```bash
# 仓库根目录
pnpm dev:server

# 或者直接跑
KUAIBAN_DB=/var/lib/kuaiban/kuaiban.db PORT=8787 node --experimental-sqlite apps/server/src/main.ts
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `KUAIBAN_DB` | `./kuaiban-server.db` | 数据库文件 |
| `KUAIBAN_ADMIN_PASSWORD` | 随机 | 首次启动时管理员的密码 |

**首次启动**会自动创建管理员 `admin`，密码随机生成并打印一次。首次登录会强制改密码。

```bash
pnpm --filter @kuaiban/server test       # 22 个接口测试（真实 HTTP）
pnpm --filter @kuaiban/server typecheck
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查（不需要登录） |
| `POST` | `/api/login` | 登录 → `{ token, user }` |
| `POST` | `/api/logout` | 退出 |
| `GET` | `/api/me` | 当前用户 |
| `POST` | `/api/password` | 改自己的密码（会作废旧令牌并发一个新的） |
| `POST` | `/api/sync` | 同步（**先拉后推**，见下） |
| `GET` | `/api/admin/users` | 用户列表（**只含条数，不含内容**） |
| `POST` | `/api/admin/users` | 建号 |
| `POST` | `/api/admin/users/:id/password` | 重置密码 |
| `POST` | `/api/admin/users/:id/disabled` | 停用 / 启用 |

认证用 `Authorization: Bearer <token>`。令牌有效期 30 天，服务端只存哈希。

## 三条关键设计

### 1. 服务端**不理解待办**

`sync_records.payload` 对服务端是一坨看不懂的字符串。逾期、重复、提醒、
冲突怎么裁决，**全在客户端的大脑里**（`packages/core/src/sync.ts`）。

好处：业务规则只写一遍，将来 Android / 鸿蒙 / iOS 都复用同一份合并逻辑，
不会出现"这个端的冲突处理和那个端不一样"这种经典灾难。

### 2. 因此"管理员看不到内容"是**做不到**，而不是"我们不看"

管理接口只能看到账号信息和"存了多少条记录"。连"为了调试"的读取路径都没有 ——
`apps/server/test/api.test.ts` 里有断言守着：往待办里写一个敏感词，
然后检查管理接口的**整个响应体**里不出现它。

### 3. 同步必须**先拉后推**

`/api/sync` 的处理顺序是先返回自游标以来的变化、再写入客户端推上来的记录。

如果反过来（先推后拉）：客户端会先把自己的版本写上去、**覆盖掉另一台设备刚推的改动**，
然后拉回来的正是自己刚写的那份 —— 它永远不知道自己覆盖掉了什么，
**对方的改动就此消失**。这是真实写出来又测试抓到的数据丢失。

## 同步协议要点

- **游标用序号，不用时间**：客户端时钟不可信（快几分钟、慢几小时都有），
  用时间做游标会漏记录。`seq` 由服务端一台机器统一分配。
- **每条写入都分配新 `seq`**：原地更新若复用旧序号，带着已超过它的游标来拉的设备
  就永远看不到这次修改 —— 一个极隐蔽的"同步丢数据"。
- **客户端只推自己改过的**（`createPushTracker`）+ **合并时本地赢了远端的**（`planPush`）。
  两个都要，少一个就会出现"两台设备永远收敛不到一起"。
