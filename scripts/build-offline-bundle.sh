#!/usr/bin/env bash
#
# 打离线安装包（T6.3）。
#
#   ./scripts/build-offline-bundle.sh                    # 用当前架构、compose 里钉的版本
#   ./scripts/build-offline-bundle.sh --out /tmp/pkg     # 换输出目录
#   ALLOWED_IMAGE_TAGS=5.0.4-24-minimal ./scripts/build-offline-bundle.sh   # 只带一个实例镜像
#
# 产出一个自包含的 tar.gz：现场机器只要装了 docker，拷过去解开、跑 install.sh 即可，
# **全程不需要外网**。
#
# 三条设计约束，改之前先读：
#
#   1. **镜像从本机取，不从网上拉**。打包机自己得先有这些镜像（`docker pull` 或
#      `compose build`）。缺哪个就报错退出 —— 打出一个缺镜像的包，
#      现场解开才发现，那趟差就白跑了。
#   2. **架构写进包名与清单**。ARM 盒子装了 amd64 的包，`docker load` 会成功、
#      容器起不来，报的是 exec format error —— 这个错和「装错包」看起来毫无关系。
#   3. **带校验和**。现场常用 U 盘拷贝，拷坏一半的包 `docker load` 报的是
#      「unexpected EOF」，同样看不出是文件坏了。
#
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="dist-offline"
for ((i = 1; i <= $#; i++)); do
  case "${!i}" in
    --out) i=$((i + 1)); OUT_DIR="${!i}" ;;
    *) echo "未知参数：${!i}" >&2; exit 2 ;;
  esac
done

# 版本号取自 manager 的 package.json —— 与镜像标签同源，避免两处各写一个
VERSION="$(node -p "require('./apps/manager/package.json').version")"
MANAGER_IMAGE="${MANAGER_IMAGE:-mqttsnet/thinglinks-edge:${VERSION}}"
PROXY_IMAGE="${PROXY_IMAGE:-wollomatic/socket-proxy:1.13.1}"
INIT_IMAGE="${INIT_IMAGE:-alpine:3.22}"
NODE_RED_REPO="${NODE_RED_IMAGE_REPO:-nodered/node-red}"
ALLOWED_IMAGE_TAGS="${ALLOWED_IMAGE_TAGS:-5.0.4-24-minimal,4.1.13-22-minimal}"

ARCH="$(docker version --format '{{.Server.Arch}}')"
NAME="thinglinks-edge-offline-${VERSION}-linux-${ARCH}"
STAGE="${OUT_DIR}/${NAME}"

IMAGES=("$MANAGER_IMAGE" "$PROXY_IMAGE" "$INIT_IMAGE")
IFS=',' read -ra TAGS <<< "$ALLOWED_IMAGE_TAGS"
for t in "${TAGS[@]}"; do IMAGES+=("${NODE_RED_REPO}:$(echo "$t" | xargs)"); done

echo "── 离线安装包 ${VERSION} · linux/${ARCH} ──"
echo

# 1) 逐个确认镜像在本机，并核对架构 —— 见约束 1、2
for img in "${IMAGES[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "✗ 本机没有镜像 $img" >&2
    echo "  先取到它再打包： docker pull $img" >&2
    echo "  Manager 自己的镜像： docker compose -f docker-compose.yml -f docker-compose.build.yml build" >&2
    exit 1
  fi
  got="$(docker image inspect "$img" --format '{{.Architecture}}')"
  if [ "$got" != "$ARCH" ]; then
    echo "✗ $img 是 $got，与本机 $ARCH 不一致 —— 装到现场会报 exec format error" >&2
    exit 1
  fi
  echo "  ✓ $img ($got)"
done

rm -rf "$STAGE"
mkdir -p "$STAGE"

# 2) 导出镜像。一个 tar 装全部：现场少一步「按顺序 load 好几个文件」
echo
echo "  导出镜像（几百 MB，耐心等）…"
docker save -o "${STAGE}/images.tar" "${IMAGES[@]}"

# 3) 部署文件。compose 主文件原样带走，另加一份 offline 覆盖：
#    pull_policy: never 让「镜像没 load 进去」当场失败，而不是去连网拉
cp docker-compose.yml "${STAGE}/"
cp .env.example "${STAGE}/"
cp -r changelogs "${STAGE}/changelogs" 2>/dev/null || true
cat > "${STAGE}/docker-compose.offline.yml" <<'YAML'
# 离线覆盖：任何服务都不许去网上拉镜像。
#
# 没有这一层的话，镜像少 load 了一个时 compose 会尝试联网拉取，
# 现场表现是「卡在 Pulling 很久然后超时」——
# 而真正该说的那句话是「这个镜像不在包里」。
services:
  docker-proxy:
    pull_policy: never
  init-data:
    pull_policy: never
  manager:
    pull_policy: never
YAML

cp scripts/offline/install.sh "${STAGE}/install.sh"
cp scripts/offline/README.md "${STAGE}/README.md"
chmod +x "${STAGE}/install.sh"

# 4) 清单：装了什么、什么架构、什么时候打的。现场核对与售后追溯都靠它
node -e '
const { execFileSync } = require("node:child_process");
const [stage, version, arch, ...images] = process.argv.slice(1);
const digest = (img) => JSON.parse(execFileSync("docker",
  ["image", "inspect", img, "--format", "{{json .Id}}"], { encoding: "utf8" }));
require("node:fs").writeFileSync(`${stage}/manifest.json`, JSON.stringify({
  product: "thinglinks-edge",
  version, platform: `linux/${arch}`,
  createdAt: new Date().toISOString(),
  images: images.map((image) => ({ image, id: digest(image) })),
}, null, 2) + "\n");
' "$STAGE" "$VERSION" "$ARCH" "${IMAGES[@]}"

# 5) 校验和 —— 见约束 3
( cd "$STAGE" && shasum -a 256 images.tar docker-compose.yml docker-compose.offline.yml \
    install.sh manifest.json .env.example > SHA256SUMS )

# 6) 打包
tar -C "$OUT_DIR" -czf "${OUT_DIR}/${NAME}.tar.gz" "$NAME"
rm -rf "$STAGE"

SIZE="$(du -h "${OUT_DIR}/${NAME}.tar.gz" | cut -f1)"
echo
echo "  ✓ ${OUT_DIR}/${NAME}.tar.gz  (${SIZE})"
echo
echo "  现场：拷过去 → tar xzf ${NAME}.tar.gz → cd ${NAME} → ./install.sh"
