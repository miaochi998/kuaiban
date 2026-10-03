# 快办服务端 —— 生产镜像
#
# 刻意用**最朴素的写法**：不引构建工具、不做多阶段编译。
# 服务端本来就是"直接用 Node 跑 TypeScript"（Node 只做类型擦除），
# 所以镜像里放源码 + 依赖就够了，没有构建产物这回事。
#
# 基础镜像用 node:24 —— `node:sqlite` 从 22 起内置，24 已经稳定，
# 这样服务端**一个第三方运行时依赖都没有**（连 SQLite 驱动都是自带的）。

FROM node:24-slim

# pnpm 只用来装依赖，运行时不跑它
RUN corepack enable

WORKDIR /app

# 先只拷"依赖清单"，让这层能被缓存住 —— 改业务代码不用重装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @kuaiban/server...

# 再拷源码
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/server apps/server

# 数据目录（数据库、发布包、签名密钥都在这里）——
# 由 compose 挂到宿主机，容器重建不会丢
ENV KUAIBAN_DB=/data/kuaiban.db \
    KUAIBAN_RELEASES_DIR=/data/releases \
    PORT=8787 \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8787

# 健康检查：让 Portainer / Docker 能看出容器是不是真的还能干活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "apps/server/src/main.ts"]
