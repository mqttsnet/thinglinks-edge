#
# 刻意不写 `# syntax=docker/dockerfile:1`：那行会让 BuildKit 每次构建都去
# 拉一个外部前端镜像，即使所有层都命中缓存也要联网（实测在网络抖动时直接构建失败）。
# 本文件只用 FROM/COPY/RUN/ENV/USER，默认前端完全够用，而离线安装是既定目标。
#
# ThingLinks Edge Manager 镜像。
#
# 构建上下文是**仓库根目录**（需要 pnpm workspace 的清单与锁文件）：
#   docker build -f apps/manager/Dockerfile -t thinglinks-edge-manager:dev .
#
# Manager 以兄弟容器模式管理实例：它需要访问宿主 docker 端点，
# 但**不**在自身容器内起 Node-RED 子进程 —— 升级 Manager 时实例不受影响。

# ── 构建阶段 ────────────────────────────────────────────────
# --platform=$BUILDPLATFORM：构建阶段**永远跑在构建机的原生架构上**，不随 --platform 走。
# 多架构发布（linux/amd64,linux/arm64）时，异架构那一份的 pnpm install + tsc + vite build
# 若跟着目标架构走就要全程 QEMU 模拟，实测慢一个数量级。这里能这么干是因为构建产物
# 与架构无关：全是 JS，唯一的原生模块 better-sqlite3 v13 在 tarball 里自带
# linuxmusl-arm64 / linuxmusl-x64 等各平台 .node，运行期才按当前平台挑。
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine AS builder
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
COPY packages packages
RUN pnpm --filter @thinglinks-edge/manager build
# 控制台按相对路径构建（base: './'），挂载前缀由 Manager 运行期注入 <base href>
RUN pnpm --filter @thinglinks-edge/web-console build

# --legacy：本仓库未开 inject-workspace-packages，pnpm 10 的 deploy 默认拒绝非注入式工作区。
# --prod：只保留运行时依赖（fastify / dockerode / better-sqlite3 / bcryptjs / @fastify/*）。
RUN pnpm --filter @thinglinks-edge/manager deploy --legacy --prod --ignore-scripts /out

# better-sqlite3 的 tarball 带着 8 个平台的预编译产物，合计 16MB，而 Alpine 运行时
# 只会加载 linuxmusl-<arch> —— 这不是推断：在跑起来的 amd64 容器里查 /proc/1/maps，
# 被 mmap 的确实是 prebuilds/linuxmusl-x64.node。
# darwin/win32 在 Linux 容器里永远用不上，linux-*（glibc）同样用不上（底座是 musl）。
# 删掉这 6 个省约 11MB。
#
# **保留两个 linuxmusl 而不是只留目标架构那一个**：构建阶段钉在 BUILDPLATFORM，
# 同一份 /out 要同时供 amd64 与 arm64 的运行阶段使用。只留一个就会让另一个架构
# 找不到原生模块 —— 而且构建不报错，要等容器跑起来才炸。
# 按 -path 匹配而不是写死版本号目录，升级 better-sqlite3 时不用回来改这里。
RUN find /out/node_modules/.pnpm -path '*/better-sqlite3/prebuilds/*.node' \
      ! -name 'linuxmusl-*' -delete

# 使用者变更说明（vX.Y.Z.zh-CN.md）随镜像走：升级后控制台要弹一次。
# 刻意放在所有 RUN **之后**：没有任何构建步骤读它，而发版前改文案是常事 ——
# 排在源码之前的话，动一个字就会让 pnpm build 与 deploy 全部重跑。
COPY changelogs changelogs

# ── 运行阶段 ────────────────────────────────────────────────
FROM node:24.19.0-alpine AS runtime
# 静态元数据放在最前面：它们从不变化，不会影响下面各层的构建缓存。
# source 这条是给 Docker Hub / GHCR 用的 —— 有它镜像页才会关联回源码仓库。
LABEL org.opencontainers.image.title="ThingLinks Edge Manager" \
      org.opencontainers.image.description="Provision, proxy and monitor Node-RED instances on one edge gateway" \
      org.opencontainers.image.vendor="mqttsnet" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/mqttsnet/thinglinks-edge" \
      org.opencontainers.image.url="https://hub.docker.com/r/mqttsnet/thinglinks-edge" \
      org.opencontainers.image.documentation="https://github.com/mqttsnet/thinglinks-edge#readme"

# alpine 不自带时区数据库。Node 自己带 ICU，所以**程序写出的时间戳本来就是对的**，
# 但容器里的 date、ls、日志文件 mtime 这些走 libc 的东西会显示 UTC ——
# 现场 docker exec 进来排障时，看到 UTC 会误判成时区没生效。装上 2MB 的 tzdata 消除歧义。
RUN apk add --no-cache tzdata

# LISTEN_ADDR 在容器内取 0.0.0.0：进程默认只监听回环是宿主部署的安全默认，
# 容器里那样会让 -p 映射失效，暴露面由端口发布策略控制。
# 刻意**不**在镜像里钉死 DATA_DIR：它的默认值由 EDGE_DATA_ROOT 派生
# （`<EDGE_DATA_ROOT>/manager`）。镜像里写死会**覆盖**那个派生值，
# 把库文件写到没有挂载的 /data —— 只读根文件系统下直接
# `unable to open database file`，可写根文件系统下更糟：悄悄落进容器可写层，
# 容器一删数据就没了，而且测试看不出来。
ENV NODE_ENV=production \
    WEB_ROOT=/app/web \
    TLE_NODE_PACKAGE_DIR=/app/nodes \
    LISTEN_ADDR=0.0.0.0 \
    LISTEN_PORT=19100

WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./package.json
COPY --from=builder /repo/apps/web-console/dist ./web
# @thinglinks 节点集：创建实例时整份拷进实例数据目录，由 nodesDir 加载
COPY --from=builder /repo/packages/thinglinks-nodes ./nodes
COPY --from=builder /repo/changelogs ./changelogs

# 非 root 运行（04-安全设计 第 96 行）。node 镜像自带 uid/gid 1000 的 node 用户。
# 访问宿主 docker.sock 另需把容器加入 socket 所属组（compose 里的 group_add），
# A4 接入受限 docker 代理后这条豁免即可撤掉。
# 数据目录不在镜像里预建：它是宿主上的 bind 挂载点（EDGE_DATA_ROOT），
# 属主由 compose 的 init-data 一次性摆平。镜像里建一个同名空目录只会掩盖
# 「忘记挂载」这种错误 —— 让它挂不上时直接失败，比默默用一个空目录好。
USER node

EXPOSE 19100

# 健康检查。有它，`docker ps` 的 STATUS 直接显示 healthy/unhealthy，
# Portainer、Swarm、以及 compose 的 `depends_on: condition: service_healthy`
# 才有依据 —— 没有 HEALTHCHECK 的镜像在这些编排面前一律是「只要进程没退出就算好」，
# 而 Node 进程卡死时它恰恰没退出。
#
# 探的是不带前缀的 /healthz：这是容器内部视角，与 EXTERNAL_URL 的挂载前缀无关
# （见 http/app.ts 里两条 /healthz 的注释）。
#
# 用 busybox 自带的 wget 而不是 `node -e`：起一次 node 要几十 MB 内存和上百毫秒，
# 在边缘小盒子上每 30 秒来一发不划算，而 wget 是镜像里已经有的东西。
# start-period 给 20 秒：首次启动要建库、跑迁移、扫已有实例容器，比稳态慢。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${LISTEN_PORT:-19100}/healthz" || exit 1

CMD ["node", "dist/index.js"]

# 逐版本变化的元数据**必须放在最后**：ARG 会让它之后的每一层缓存失效，
# 而 IMAGE_REVISION / IMAGE_CREATED 每次构建都不同 —— 放在前面等于每次全量重建。
# 这三个值由 scripts/publish-image.sh 与 CI 注入，本地随手构建时用默认值即可。
ARG IMAGE_VERSION=dev
ARG IMAGE_REVISION=unknown
ARG IMAGE_CREATED=unknown
LABEL org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.created="${IMAGE_CREATED}"
