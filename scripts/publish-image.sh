#!/usr/bin/env bash
#
# 把 Manager 镜像构建成多架构清单并推送到 Docker Hub。
#
#   ./scripts/publish-image.sh                 # 用 package.json 的版本号，推 X.Y.Z / X.Y / latest
#   ./scripts/publish-image.sh --dry-run       # 只构建不推送，用来验证改动没把构建搞坏
#   ./scripts/publish-image.sh --no-latest     # 修旧版本线时用：不要动 latest
#   VERSION=0.2.0-rc1 ./scripts/publish-image.sh --no-latest
#
# 推送前需要先登录（脚本不碰你的凭据）：
#   docker login -u mqttsnet
# 口令栏填 Docker Hub 的 Access Token，不要填账号密码 ——
# token 可以单独吊销，而且能限定为只读/读写，账号密码泄露就是全盘。

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-mqttsnet/thinglinks-edge}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-thinglinks-edge}"

PUSH=1
TAG_LATEST=1
for arg in "$@"; do
  case "$arg" in
    --dry-run)   PUSH=0 ;;
    --no-latest) TAG_LATEST=0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# 版本号只有一个真源：根 package.json。手工传 VERSION 只为发预览版。
VERSION="${VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)}"
[ -n "$VERSION" ] || { echo "读不到版本号" >&2; exit 1; }

REVISION="$(git rev-parse HEAD)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 工作区脏就拒绝推送。镜像里的 revision 标签会指向一个**不包含你实际构建内容**的
# commit —— 三个月后照着这个 sha 复现问题时会得到一个跑不出同样现象的构建。
if [ "$PUSH" = 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动，拒绝推送。" >&2
  echo "先提交（镜像的 revision 标签要指向真实构建源），或用 --dry-run 只构建。" >&2
  exit 1
fi

TAGS=(--tag "$IMAGE:$VERSION")
# X.Y 浮动 tag：让别人可以钉在 0.1 上自动吃补丁版，但不会被 0.2 的破坏性改动打到
MINOR="$(printf '%s' "$VERSION" | cut -d. -f1,2)"
case "$VERSION" in
  *-*) : ;;                                   # 预览版（0.2.0-rc1）不动浮动 tag
  *)   TAGS+=(--tag "$IMAGE:$MINOR")
       [ "$TAG_LATEST" = 1 ] && TAGS+=(--tag "$IMAGE:latest") ;;
esac

# 选构建器。出多架构清单要求构建器能导出 manifest list，两条路都行：
#
#   1. 开了 containerd 镜像存储的 Docker（Desktop 4.34+ 默认开，Engine 可手动开）——
#      默认构建器就能出多架构，不用额外拉东西。
#   2. 其余情况 —— 需要 docker-container 驱动的构建器，它会先拉一个
#      moby/buildkit 镜像（约 150MB）。网络差的时候这一步能卡很久，
#      所以能走第 1 条就别走第 2 条。
#
# 用老式 docker 驱动直接传多个 --platform 会报
# "docker exporter does not currently support exporting manifest lists"。
# 数组展开用 ${a[@]+"${a[@]}"} 而不是 "${a[@]}"：macOS 自带 bash 3.2，
# 那里 set -u 下展开空数组会直接报 unbound variable 并终止脚本。
BUILDER_ARGS=()
if docker info -f '{{.DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
  echo "==> 构建器  默认（已启用 containerd 镜像存储）"
else
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "==> 创建 buildx 构建器 $BUILDER（docker-container 驱动，首次会拉 buildkit 镜像）"
    docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
  fi
  BUILDER_ARGS=(--builder "$BUILDER")
  echo "==> 构建器  $BUILDER（docker-container 驱动）"
fi

echo "==> 镜像    $IMAGE"
echo "==> 版本    $VERSION  ($REVISION)"
echo "==> 架构    $PLATFORMS"
echo "==> tag     $(printf '%s ' "${TAGS[@]}" | sed 's/--tag //g')"
[ "$PUSH" = 1 ] && echo "==> 推送    是" || echo "==> 推送    否（--dry-run）"

docker buildx build \
  ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"} \
  --platform "$PLATFORMS" \
  --file apps/manager/Dockerfile \
  "${TAGS[@]}" \
  --build-arg "IMAGE_VERSION=$VERSION" \
  --build-arg "IMAGE_REVISION=$REVISION" \
  --build-arg "IMAGE_CREATED=$CREATED" \
  --provenance=false \
  $( [ "$PUSH" = 1 ] && echo --push ) \
  .

if [ "$PUSH" = 1 ]; then
  echo
  echo "已推送。验证多架构清单："
  echo "  docker buildx imagetools inspect $IMAGE:$VERSION"
fi
