# syntax=docker/dockerfile:1
#
# ThingLinks Edge Manager 镜像。
#
# 构建上下文是**仓库根目录**（需要 pnpm workspace 的清单与锁文件）：
#   docker build -f apps/manager/Dockerfile -t thinglinks-edge-manager:dev .
#
# Manager 以兄弟容器模式管理实例：它需要访问宿主 docker 端点，
# 但**不**在自身容器内起 Node-RED 子进程 —— 升级 Manager 时实例不受影响。

# ── 构建阶段 ────────────────────────────────────────────────
FROM node:24.19.0-alpine AS builder
WORKDIR /repo
RUN corepack enable

# 先只拷依赖清单，依赖层可跨代码改动复用
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/manager/package.json apps/manager/package.json
COPY apps/web-console/package.json apps/web-console/package.json
# --ignore-scripts：唯一带 binding.gyp 的依赖是 better-sqlite3，而 v13 自带
# 各平台预编译产物（lib/binding.js 优先加载 prebuilds/，musl 亦有），
# 跑 node-gyp 只会因 alpine 无 python3/g++ 而失败，且编译出来的东西根本用不上。
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/manager apps/manager
COPY apps/web-console apps/web-console
RUN pnpm --filter @thinglinks-edge/manager build
# 控制台按相对路径构建（base: './'），挂载前缀由 Manager 运行期注入 <base href>
RUN pnpm --filter @thinglinks-edge/web-console build

# --legacy：本仓库未开 inject-workspace-packages，pnpm 10 的 deploy 默认拒绝非注入式工作区。
# --prod：只保留运行时依赖（fastify / dockerode / better-sqlite3 / bcryptjs / @fastify/*）。
RUN pnpm --filter @thinglinks-edge/manager deploy --legacy --prod --ignore-scripts /out

# ── 运行阶段 ────────────────────────────────────────────────
FROM node:24.19.0-alpine AS runtime
LABEL org.opencontainers.image.title="ThingLinks Edge Manager" \
      org.opencontainers.image.vendor="mqttsnet" \
      org.opencontainers.image.licenses="Apache-2.0"

# LISTEN_ADDR 在容器内取 0.0.0.0：进程默认只监听回环是宿主部署的安全默认，
# 容器里那样会让 -p 映射失效，暴露面由端口发布策略控制。
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_ROOT=/app/web \
    LISTEN_ADDR=0.0.0.0 \
    LISTEN_PORT=8080

WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /repo/apps/web-console/dist ./web

# 非 root 运行（04-安全设计 第 96 行）。node 镜像自带 uid/gid 1000 的 node 用户。
# 访问宿主 docker.sock 另需把容器加入 socket 所属组（compose 里的 group_add），
# A4 接入受限 docker 代理后这条豁免即可撤掉。
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
