#!/bin/sh
# 全量回归 —— 每次改动后必须全绿。回归只增不减。
#
# 用法： pnpm verify
set -e

MANAGER_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$MANAGER_DIR/../.." && pwd)
cd "$MANAGER_DIR"

VERIFY_RUN_ID=${TLE_VERIFY_RUN_ID:-"verify-$(date -u +%Y%m%d%H%M%S)-$$"}
case "$VERIFY_RUN_ID" in
  ''|*[!a-z0-9_.-]*|.*|-*)
    echo "TLE_VERIFY_RUN_ID 只能使用小写字母、数字、点、下划线和连字符，且必须以字母或数字开头" >&2
    exit 2
    ;;
esac
if [ "${#VERIFY_RUN_ID}" -gt 80 ]; then
  echo "TLE_VERIFY_RUN_ID 不能超过 80 个字符" >&2
  exit 2
fi
export TLE_VERIFY_RUN_ID="$VERIFY_RUN_ID"

VERIFY_RUN_LABEL='com.mqttsnet.thinglinks-edge.verifier-run'
EXCLUSIVE_DOCKER=${TLE_VERIFY_EXCLUSIVE_DOCKER:-0}
case "$EXCLUSIVE_DOCKER" in
  0|1) ;;
  *)
    echo "TLE_VERIFY_EXCLUSIVE_DOCKER 只能是 0 或 1" >&2
    exit 2
    ;;
esac
RUNTIME_BUILD_TAG="thinglinks-edge-manager-verify:${VERIFY_RUN_ID}"
BUILDER_BUILD_TAG="thinglinks-edge-manager-builder-verify:${VERIFY_RUN_ID}"
UNRESOLVED_IMAGE_ID='unresolved'
BUILT_RUNTIME_TAG=''
BUILT_RUNTIME_ID=''
BUILT_BUILDER_TAG=''
BUILT_BUILDER_ID=''
SEED_EXPORT_CONTAINER_ID=''
ARTIFACT_ROOT=''
ARTIFACT_PREFIX=''
ARTIFACT_MARKER=''

BEFORE_C=$(mktemp)
BEFORE_V=$(mktemp)
BEFORE_N=$(mktemp)
AFTER_C=''
AFTER_V=''
AFTER_N=''

seed_export_owned() {
  [ -n "$SEED_EXPORT_CONTAINER_ID" ] || return 1
  SEED_EXPORT_OWNER=$(docker inspect --format \
    '{{ index .Config.Labels "com.mqttsnet.thinglinks-edge.verifier-run" }}' \
    "$SEED_EXPORT_CONTAINER_ID" 2>/dev/null) || return 1
  [ "$SEED_EXPORT_OWNER" = "$VERIFY_RUN_ID" ]
}

remove_seed_export() {
  [ -n "$SEED_EXPORT_CONTAINER_ID" ] || return 0
  if ! seed_export_owned; then
    echo "拒绝清理 ownership 不属于本次运行的 seed 导出容器：$SEED_EXPORT_CONTAINER_ID" >&2
    return 1
  fi
  docker rm -f "$SEED_EXPORT_CONTAINER_ID" >/dev/null
  SEED_EXPORT_CONTAINER_ID=''
}

artifact_root_owned() {
  [ -n "$ARTIFACT_ROOT" ] && [ -n "$ARTIFACT_PREFIX" ] && [ -n "$ARTIFACT_MARKER" ] || return 1
  case "$ARTIFACT_ROOT" in
    "$ARTIFACT_PREFIX"*) ;;
    *) return 1 ;;
  esac
  ARTIFACT_CANONICAL=$(CDPATH= cd -- "$ARTIFACT_ROOT" 2>/dev/null && pwd -P) || return 1
  [ "$ARTIFACT_CANONICAL" = "$ARTIFACT_ROOT" ] || return 1
  [ -f "$ARTIFACT_MARKER" ] && [ ! -L "$ARTIFACT_MARKER" ] || return 1
  ARTIFACT_OWNER=$(sed -n '1p' "$ARTIFACT_MARKER")
  [ "$ARTIFACT_OWNER" = "$VERIFY_RUN_ID" ]
}

image_label() {
  LABEL_IMAGE_REF=$1
  LABEL_KEY=$2
  docker image inspect --format "{{ index .Config.Labels \"$LABEL_KEY\" }}" \
    "$LABEL_IMAGE_REF" 2>/dev/null
}

task_tag_owned() {
  OWNED_TAG=$1
  OWNED_EXPECTED_ID=$2
  [ -n "$OWNED_TAG" ] && [ -n "$OWNED_EXPECTED_ID" ] || return 1
  OWNED_CURRENT_ID=$(docker image inspect --format '{{.Id}}' "$OWNED_TAG" 2>/dev/null) || return 1
  OWNED_CURRENT_RUN=$(image_label "$OWNED_TAG" "$VERIFY_RUN_LABEL") || return 1
  [ "$OWNED_CURRENT_RUN" = "$VERIFY_RUN_ID" ] || return 1
  [ "$OWNED_EXPECTED_ID" = "$UNRESOLVED_IMAGE_ID" ] \
    || [ "$OWNED_CURRENT_ID" = "$OWNED_EXPECTED_ID" ]
}

remove_task_tag() {
  REMOVE_TAG=$1
  REMOVE_EXPECTED_ID=$2
  if [ "$REMOVE_EXPECTED_ID" = "$UNRESOLVED_IMAGE_ID" ]; then
    if ! REMOVE_CANDIDATE=$(docker image ls -q --no-trunc "$REMOVE_TAG" 2>/dev/null); then
      echo "无法确认未解析的 task-owned 镜像 tag：$REMOVE_TAG" >&2
      return 1
    fi
    # build 在落 tag 前失败时无事可清；一旦 tag 存在，仍须通过本轮 label 核验。
    [ -n "$REMOVE_CANDIDATE" ] || return 0
  fi
  if ! task_tag_owned "$REMOVE_TAG" "$REMOVE_EXPECTED_ID"; then
    echo "拒绝删除 ownership 或 image ID 已变化的 task-owned tag：$REMOVE_TAG" >&2
    return 1
  fi
  if ! docker image rm "$REMOVE_TAG" >/dev/null 2>&1; then
    echo "删除 task-owned 镜像 tag 失败：$REMOVE_TAG" >&2
    return 1
  fi
  if ! REMOVE_REMAINING=$(docker image ls -q --no-trunc "$REMOVE_TAG" 2>/dev/null); then
    echo "无法确认 task-owned 镜像 tag 已删除：$REMOVE_TAG" >&2
    return 1
  fi
  if [ -n "$REMOVE_REMAINING" ]; then
    echo "task-owned 镜像 tag 删除后仍存在：$REMOVE_TAG" >&2
    return 1
  fi
}

cleanup_task_tags() {
  TAG_CLEANUP_FAILED=0
  if [ -n "$BUILT_BUILDER_TAG" ]; then
    CLEAN_TAG=$BUILT_BUILDER_TAG
    CLEAN_ID=$BUILT_BUILDER_ID
    BUILT_BUILDER_TAG=''
    BUILT_BUILDER_ID=''
    remove_task_tag "$CLEAN_TAG" "$CLEAN_ID" || TAG_CLEANUP_FAILED=1
  fi
  if [ -n "$BUILT_RUNTIME_TAG" ]; then
    CLEAN_TAG=$BUILT_RUNTIME_TAG
    CLEAN_ID=$BUILT_RUNTIME_ID
    BUILT_RUNTIME_TAG=''
    BUILT_RUNTIME_ID=''
    remove_task_tag "$CLEAN_TAG" "$CLEAN_ID" || TAG_CLEANUP_FAILED=1
  fi
  [ "$TAG_CLEANUP_FAILED" -eq 0 ]
}

cleanup() {
  CLEANUP_STATUS=$?
  trap - 0 1 2 15
  if [ -n "$SEED_EXPORT_CONTAINER_ID" ] && ! remove_seed_export; then
    CLEANUP_STATUS=1
  fi
  if ! cleanup_task_tags; then
    CLEANUP_STATUS=1
  fi
  rm -f "$BEFORE_C" "$BEFORE_V" "$BEFORE_N"
  [ -z "$AFTER_C" ] || rm -f "$AFTER_C"
  [ -z "$AFTER_V" ] || rm -f "$AFTER_V"
  [ -z "$AFTER_N" ] || rm -f "$AFTER_N"
  if [ -n "$ARTIFACT_ROOT" ]; then
    if artifact_root_owned; then
      rm -rf "$ARTIFACT_ROOT"
    else
      echo "拒绝清理不属于本次运行的临时目录：$ARTIFACT_ROOT" >&2
      CLEANUP_STATUS=1
    fi
  fi
  exit "$CLEANUP_STATUS"
}
signal_exit() {
  trap - 1 2 15
  exit "$1"
}

snapshot_docker_resources() {
  SNAPSHOT_KIND=$1
  SNAPSHOT_OUT=$2

  if [ "$EXCLUSIVE_DOCKER" = 1 ]; then
    case "$SNAPSHOT_KIND" in
      containers) docker ps -aq | sort > "$SNAPSHOT_OUT" ;;
      volumes) docker volume ls -q | sort > "$SNAPSHOT_OUT" ;;
      networks) docker network ls -q | sort > "$SNAPSHOT_OUT" ;;
      *) echo "未知 Docker 资源类型：$SNAPSHOT_KIND" >&2; return 2 ;;
    esac
    return
  fi

  # 本地 Docker Desktop 常与其他项目共享。只比较 ThingLinks Edge 命名/标签
  # 范围内的资源，避免把同期启动的 LibreChat 等无关容器当成本轮泄漏。
  case "$SNAPSHOT_KIND" in
    containers)
      docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Labels}}' \
        | awk -F '\t' '$2 ~ /^(tle-|thinglinks-edge-)/ || $3 ~ /com[.]mqttsnet[.]thinglinks-edge[.]/ { print $1 }' \
        | sort -u > "$SNAPSHOT_OUT"
      ;;
    volumes)
      docker volume ls --format '{{.Name}}\t{{.Labels}}' \
        | awk -F '\t' '$1 ~ /^(tle-|thinglinks-edge-)/ || $2 ~ /com[.]mqttsnet[.]thinglinks-edge[.]/ { print $1 }' \
        | sort -u > "$SNAPSHOT_OUT"
      ;;
    networks)
      docker network ls --format '{{.ID}}\t{{.Name}}\t{{.Labels}}' \
        | awk -F '\t' '$2 ~ /^(tle-|thinglinks-edge-)/ || $3 ~ /com[.]mqttsnet[.]thinglinks-edge[.]/ { print $1 }' \
        | sort -u > "$SNAPSHOT_OUT"
      ;;
    *) echo "未知 Docker 资源类型：$SNAPSHOT_KIND" >&2; return 2 ;;
  esac
}

trap cleanup 0
trap 'signal_exit 129' 1
trap 'signal_exit 130' 2
trap 'signal_exit 143' 15

echo ""
echo "════════ ThingLinks Edge · 全量回归 ════════"
echo "  run: $VERIFY_RUN_ID"
echo ""

# 只读拍下 Docker resource ID。收尾只比较新增集合，不删除任何残留。
# CI runner 用独占模式覆盖全部资源；共享的本地 Docker 主机只跟踪 ThingLinks 资源。
snapshot_docker_resources containers "$BEFORE_C"
snapshot_docker_resources volumes "$BEFORE_V"
snapshot_docker_resources networks "$BEFORE_N"

test_summary() {
  TEST_LABEL=$1
  shift
  TEST_LOG=$(mktemp)
  if "$@" >"$TEST_LOG" 2>&1; then
    TEST_STATUS=0
  else
    TEST_STATUS=$?
  fi
  TEST_COUNTS=$(grep -E '^# (tests|pass|fail|skipped)' "$TEST_LOG" \
    | tr '\n' ' ' | sed 's/# //g' || true)
  printf "  %-24s %s\n" "$TEST_LABEL" "$TEST_COUNTS"
  if [ "$TEST_STATUS" -ne 0 ]; then
    tail -20 "$TEST_LOG" | sed 's/^/      /'
  fi
  rm -f "$TEST_LOG"
  return "$TEST_STATUS"
}

echo "── 快速测试 ──"
# 先跑单测再花时间构建镜像。test_summary 显式保存 pnpm 的退出码，不能让
# grep/tr/sed 摘要管道把失败改写成成功。
test_summary "manager" pnpm test
test_summary "console" pnpm --filter @thinglinks-edge/web-console test
echo ""

echo "── 类型与构建 ──"
pnpm typecheck >/dev/null 2>&1 && echo "  manager typecheck ✓" || { echo "  manager typecheck ✗"; exit 1; }
pnpm build >/dev/null 2>&1 && echo "  manager build ✓" || { echo "  manager build ✗"; exit 1; }
# 控制台构建即类型检查（build 脚本是 vue-tsc --noEmit && vite build）
pnpm --filter @thinglinks-edge/web-console build >/dev/null 2>&1 \
  && echo "  console 构建 ✓" || { echo "  console 构建 ✗"; exit 1; }
test_summary "验证脚本跨平台" node --test scripts/verify-temp-parent.test.mjs
test_summary "离线包构建契约" node --test scripts/build-offline-bundle.test.mjs
test_summary "离线包解析契约" node --test scripts/verify-offline-bundle.test.mjs
test_summary "真实实例夹具契约" node --test \
  scripts/real-instance-fixture.test.mjs \
  scripts/verify-api.test.mjs \
  scripts/verify-compose.test.mjs \
  scripts/verify-nodes.test.mjs \
  scripts/verify-baseline.test.mjs \
  scripts/verify-core-resource-ownership.test.mjs \
  scripts/verify-cloud-resource-ownership.test.mjs \
  scripts/verify-offline.test.mjs \
  scripts/resource-ledger.test.mjs \
  scripts/transport-diagnostics.test.mjs \
  scripts/verifier-subnet.test.mjs \
  scripts/verifier-temp-lifecycle.test.mjs
test_summary "协议与串口工具契约" sh -c '
  cd "$1" && node --experimental-strip-types --test \
    scripts/prepare-protocol-seed.test.mjs \
    scripts/verify-protocol-components.test.mjs \
    scripts/protocol-fixtures/*.test.mjs \
    scripts/protocol-wire-lab/serial/*.test.cjs
' _ "$REPO_ROOT"
echo ""

image_id() {
  IMAGE_REF=$1
  if ! RESOLVED_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_REF" 2>/dev/null); then
    echo "镜像不存在或不可检查：$IMAGE_REF" >&2
    return 1
  fi
  if ! printf '%s\n' "$RESOLVED_IMAGE_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    echo "镜像没有解析为不可变 sha256 ID：$IMAGE_REF -> $RESOLVED_IMAGE_ID" >&2
    return 1
  fi
  printf '%s\n' "$RESOLVED_IMAGE_ID"
}

require_unused_build_tag() {
  CANDIDATE_TAG=$1
  if docker image inspect "$CANDIDATE_TAG" >/dev/null 2>&1; then
    echo "自动构建 tag 已存在，拒绝覆盖或清理外部镜像：$CANDIDATE_TAG" >&2
    return 1
  fi
}

echo "── 当前 checkout 制品 ──"
unset TLE_PLATFORM_BUILDER_IMAGE TLE_PLATFORM_OFFLINE_BUNDLE
MANAGER_IMAGE_INPUT=${MANAGER_IMAGE:-}
CURRENT_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
if [ -z "$MANAGER_IMAGE_INPUT" ]; then
  require_unused_build_tag "$RUNTIME_BUILD_TAG"
  # 在 build 可能落 tag 之前先记账。后续 inspect 失败或收到信号时，
  # EXIT trap 仍会按本轮 label 回收，不会把临时 tag 遗留在共享 daemon。
  BUILT_RUNTIME_TAG=$RUNTIME_BUILD_TAG
  BUILT_RUNTIME_ID=$UNRESOLVED_IMAGE_ID
  IMAGE_CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "  构建 Manager runtime …"
  docker build \
    --label "$VERIFY_RUN_LABEL=$VERIFY_RUN_ID" \
    --build-arg "IMAGE_VERSION=verify-$VERIFY_RUN_ID" \
    --build-arg "IMAGE_REVISION=$CURRENT_HEAD" \
    --build-arg "IMAGE_CREATED=$IMAGE_CREATED" \
    -f "$REPO_ROOT/apps/manager/Dockerfile" \
    -t "$RUNTIME_BUILD_TAG" \
    "$REPO_ROOT"
  MANAGER_IMAGE_INPUT=$RUNTIME_BUILD_TAG
  MANAGER_IMAGE=$(image_id "$MANAGER_IMAGE_INPUT")
  BUILT_RUNTIME_ID=$MANAGER_IMAGE
  if ! MANAGER_IMAGE_RUN=$(image_label "$MANAGER_IMAGE" "$VERIFY_RUN_LABEL") \
      || [ "$MANAGER_IMAGE_RUN" != "$VERIFY_RUN_ID" ]; then
    echo "Manager runtime 缺少本次 verifier-run label：$MANAGER_IMAGE_INPUT" >&2
    exit 1
  fi
  BUNDLE_MANAGER_IMAGE=$RUNTIME_BUILD_TAG
  BUNDLE_MANAGER_TASK_OWNED=1
else
  echo "  校验并复用显式 MANAGER_IMAGE …"
  case "$MANAGER_IMAGE_INPUT" in
    sha256:*|*@sha256:*)
      echo "显式 MANAGER_IMAGE 必须是可由 offline bundle 恢复的 named tag，不能是裸 ID/digest" >&2
      exit 1
      ;;
  esac
  MANAGER_IMAGE=$(image_id "$MANAGER_IMAGE_INPUT")
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
    echo "工作区不干净，拒绝用显式 MANAGER_IMAGE 验证另一份源码快照" >&2
    exit 1
  fi
  EXPLICIT_REVISION=$(image_label "$MANAGER_IMAGE_INPUT" 'org.opencontainers.image.revision') || {
    echo "无法读取显式 MANAGER_IMAGE 的 OCI revision：$MANAGER_IMAGE_INPUT" >&2
    exit 1
  }
  if [ "$EXPLICIT_REVISION" != "$CURRENT_HEAD" ]; then
    echo "显式 MANAGER_IMAGE 的 OCI revision ($EXPLICIT_REVISION) 与当前 HEAD ($CURRENT_HEAD) 不一致" >&2
    exit 1
  fi
  BUNDLE_MANAGER_IMAGE=$MANAGER_IMAGE_INPUT
  BUNDLE_MANAGER_TASK_OWNED=0
fi
export MANAGER_IMAGE
TLE_PLATFORM_RUNTIME_IMAGE=$MANAGER_IMAGE
export TLE_PLATFORM_RUNTIME_IMAGE
echo "  runtime $MANAGER_IMAGE"

require_unused_build_tag "$BUILDER_BUILD_TAG"
BUILT_BUILDER_TAG=$BUILDER_BUILD_TAG
BUILT_BUILDER_ID=$UNRESOLVED_IMAGE_ID
echo "  构建同 checkout builder target …"
docker build \
  --target builder \
  --label "$VERIFY_RUN_LABEL=$VERIFY_RUN_ID" \
  --label "org.opencontainers.image.revision=$CURRENT_HEAD" \
  -f "$REPO_ROOT/apps/manager/Dockerfile" \
  -t "$BUILDER_BUILD_TAG" \
  "$REPO_ROOT"
TLE_PLATFORM_BUILDER_IMAGE=$(image_id "$BUILDER_BUILD_TAG")
BUILT_BUILDER_ID=$TLE_PLATFORM_BUILDER_IMAGE
if ! BUILDER_IMAGE_RUN=$(image_label "$TLE_PLATFORM_BUILDER_IMAGE" "$VERIFY_RUN_LABEL") \
    || [ "$BUILDER_IMAGE_RUN" != "$VERIFY_RUN_ID" ]; then
  echo "Manager builder 缺少本次 verifier-run label：$BUILDER_BUILD_TAG" >&2
  exit 1
fi
export TLE_PLATFORM_BUILDER_IMAGE
echo "  builder $TLE_PLATFORM_BUILDER_IMAGE"

bundle_manager_ref_stable() {
  if ! BUNDLE_CURRENT_ID=$(image_id "$BUNDLE_MANAGER_IMAGE") \
      || [ "$BUNDLE_CURRENT_ID" != "$MANAGER_IMAGE" ]; then
    return 1
  fi
  if [ "$BUNDLE_MANAGER_TASK_OWNED" -eq 1 ]; then
    task_tag_owned "$BUNDLE_MANAGER_IMAGE" "$MANAGER_IMAGE" || return 1
  fi
  return 0
}

ARTIFACT_PARENT=$(CDPATH= cd -- "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || {
  echo "临时目录父路径不可用：${TMPDIR:-/tmp}" >&2
  exit 1
}
if [ "$ARTIFACT_PARENT" = / ]; then
  echo "拒绝把文件系统根目录用作制品临时目录父路径" >&2
  exit 1
fi
ARTIFACT_PREFIX="$ARTIFACT_PARENT/tle-verify-artifacts.${VERIFY_RUN_ID}."
ARTIFACT_ROOT=$(mktemp -d "${ARTIFACT_PREFIX}XXXXXX")
ARTIFACT_ROOT=$(CDPATH= cd -- "$ARTIFACT_ROOT" && pwd -P)
case "$ARTIFACT_ROOT" in
  "$ARTIFACT_PREFIX"*) ;;
  *) echo "mktemp 返回了边界外路径：$ARTIFACT_ROOT" >&2; exit 1 ;;
esac
ARTIFACT_MARKER="$ARTIFACT_ROOT/.tle-verify-owner"
(umask 077 && printf '%s\n' "$VERIFY_RUN_ID" > "$ARTIFACT_MARKER")
SEED_DIR="$ARTIFACT_ROOT/node-seed"
OFFLINE_DIR="$ARTIFACT_ROOT/offline"
mkdir -p "$SEED_DIR" "$OFFLINE_DIR"

# Buildx/containerd 的 inspect ID 是 OCI descriptor D；docker save 中 Config bytes
# 的 sha256 是 image config C，二者合法地可以不同。先按不可变 D 单独导出，
# 从唯一 Config bytes 得到 C；后续 verifier 用 D，bundle 内容契约用 C。
if ! bundle_manager_ref_stable; then
  echo "bundle Manager tag 在 descriptor 取证前已不再指向已验证 runtime" >&2
  exit 1
fi
RUNTIME_ARCH=$(docker version --format '{{.Server.Arch}}')
REFERENCE_TAR="$ARTIFACT_ROOT/runtime-by-id.tar"
if [ -e "$REFERENCE_TAR" ]; then
  echo "descriptor reference tar 路径已存在：$REFERENCE_TAR" >&2
  exit 1
fi
docker save -o "$REFERENCE_TAR" "$MANAGER_IMAGE"
if [ ! -f "$REFERENCE_TAR" ] || [ -L "$REFERENCE_TAR" ]; then
  echo "descriptor reference tar 不是本次生成的普通文件：$REFERENCE_TAR" >&2
  exit 1
fi
RUNTIME_CONFIG_ID=$(node scripts/verify-offline-bundle.mjs \
  --single-config-id "$REFERENCE_TAR" "$RUNTIME_ARCH")
if ! printf '%s\n' "$RUNTIME_CONFIG_ID" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "descriptor reference tar 未导出合法 Config ID：$RUNTIME_CONFIG_ID" >&2
  exit 1
fi
rm -f "$REFERENCE_TAR"
if [ -e "$REFERENCE_TAR" ]; then
  echo "descriptor reference tar 删除失败：$REFERENCE_TAR" >&2
  exit 1
fi
if ! bundle_manager_ref_stable; then
  echo "bundle Manager tag 在 descriptor 取证后已不再指向已验证 runtime" >&2
  exit 1
fi
echo "  descriptor $MANAGER_IMAGE -> config $RUNTIME_CONFIG_ID"

CREATED_SEED_EXPORT_ID=$(docker create \
  --label "$VERIFY_RUN_LABEL=$VERIFY_RUN_ID" \
  "$TLE_PLATFORM_BUILDER_IMAGE")
if ! printf '%s\n' "$CREATED_SEED_EXPORT_ID" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "docker create 未返回不可变容器 ID：$CREATED_SEED_EXPORT_ID" >&2
  exit 1
fi
SEED_EXPORT_CONTAINER_ID=$CREATED_SEED_EXPORT_ID
if ! seed_export_owned; then
  echo "seed 导出容器缺少本次运行 ownership：$SEED_EXPORT_CONTAINER_ID" >&2
  exit 1
fi
docker cp "$SEED_EXPORT_CONTAINER_ID:/out/npm-seed/." "$SEED_DIR"
remove_seed_export

echo "  生成唯一 offline bundle …"
if ! bundle_manager_ref_stable; then
  echo "bundle Manager tag 在打包前已不再指向已验证 runtime" >&2
  exit 1
fi
MANAGER_IMAGE="$BUNDLE_MANAGER_IMAGE" \
PROXY_IMAGE="${PROXY_IMAGE:-wollomatic/socket-proxy:1.13.1}" \
INIT_IMAGE="${INIT_IMAGE:-alpine:3.22}" \
NODE_RED_IMAGE_REPO='nodered/node-red' \
ALLOWED_IMAGE_TAGS='5.0.4-24-minimal' \
NODE_SEED_DIR="$SEED_DIR" \
  bash "$REPO_ROOT/scripts/build-offline-bundle.sh" --out "$OFFLINE_DIR"
if ! bundle_manager_ref_stable; then
  echo "bundle Manager tag 在打包后已不再指向已验证 runtime" >&2
  exit 1
fi
set -- "$OFFLINE_DIR"/thinglinks-edge-offline-*-linux-*.tar.gz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "offline bundle 产物数量不是 1：$OFFLINE_DIR" >&2
  exit 1
fi
TLE_PLATFORM_OFFLINE_BUNDLE=$1
export TLE_PLATFORM_OFFLINE_BUNDLE
echo "  offline $TLE_PLATFORM_OFFLINE_BUNDLE"

if BUNDLE_CONTRACT_OUT=$(node scripts/verify-offline-bundle.mjs \
    "$TLE_PLATFORM_OFFLINE_BUNDLE" "$BUNDLE_MANAGER_IMAGE" "$RUNTIME_CONFIG_ID" 2>&1); then
  BUNDLE_CONTRACT_STATUS=0
else
  BUNDLE_CONTRACT_STATUS=$?
fi
BUNDLE_CONTRACT_MARKERS=$(printf '%s\n' "$BUNDLE_CONTRACT_OUT" \
  | grep -oE '[0-9]+/[0-9]+ 通过' || true)
BUNDLE_CONTRACT_MARKER_COUNT=$(printf '%s\n' "$BUNDLE_CONTRACT_MARKERS" \
  | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$BUNDLE_CONTRACT_STATUS" -ne 0 ] || [ "$BUNDLE_CONTRACT_MARKER_COUNT" -ne 1 ]; then
  echo "  ✗ exact offline bundle 契约失败（exit ${BUNDLE_CONTRACT_STATUS}，marker ${BUNDLE_CONTRACT_MARKER_COUNT}）" >&2
  printf '%s\n' "$BUNDLE_CONTRACT_OUT" | tail -20 | sed 's/^/      /' >&2
  exit 1
fi
BUNDLE_CONTRACT_RATIO=${BUNDLE_CONTRACT_MARKERS% 通过}
if [ "${BUNDLE_CONTRACT_RATIO#*/}" -le 0 ] \
    || [ "${BUNDLE_CONTRACT_RATIO%/*}" != "${BUNDLE_CONTRACT_RATIO#*/}" ]; then
  echo "  ✗ exact offline bundle 契约未全绿：$BUNDLE_CONTRACT_MARKERS" >&2
  exit 1
fi
echo "  exact bundle $BUNDLE_CONTRACT_MARKERS"

ARTIFACT_TEST_LOG=$(mktemp)
if node --experimental-strip-types --test src/core/nodes/seed.test.ts \
    >"$ARTIFACT_TEST_LOG" 2>&1; then
  ARTIFACT_TEST_STATUS=0
else
  ARTIFACT_TEST_STATUS=$?
fi
ARTIFACT_TEST_COUNTS=$(grep -E '^# (tests|pass|fail|skipped)' "$ARTIFACT_TEST_LOG" \
  | tr '\n' ' ' | sed 's/# //g' || true)
printf "  %-24s %s\n" "生产制品 seed.test" "$ARTIFACT_TEST_COUNTS"
if [ "$ARTIFACT_TEST_STATUS" -eq 0 ] \
    && ! grep -Eq '^# skipped 0$' "$ARTIFACT_TEST_LOG"; then
  echo "  ✗ seed.test.ts 的生产制品用例仍有 skip" >&2
  ARTIFACT_TEST_STATUS=1
fi
if [ "$ARTIFACT_TEST_STATUS" -ne 0 ]; then
  tail -30 "$ARTIFACT_TEST_LOG" | sed 's/^/      /'
fi
rm -f "$ARTIFACT_TEST_LOG"
if [ "$ARTIFACT_TEST_STATUS" -ne 0 ]; then
  exit "$ARTIFACT_TEST_STATUS"
fi
echo ""

echo "── 真容器验证 ──"
FAILED=0
run() {
  name=$1
  shift
  printf "  %-30s " "$name"
  if out=$(node "$@" 2>&1); then
    RUN_STATUS=0
  else
    RUN_STATUS=$?
  fi
  RUN_MARKERS=$(printf '%s\n' "$out" | grep -oE '[0-9]+/[0-9]+ 通过' || true)
  RUN_MARKER_COUNT=$(printf '%s\n' "$RUN_MARKERS" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$RUN_STATUS" -eq 0 ] && [ "$RUN_MARKER_COUNT" -eq 1 ]; then
    RUN_MARKER=$RUN_MARKERS
    RUN_RATIO=${RUN_MARKER% 通过}
    RUN_PASSED=${RUN_RATIO%/*}
    RUN_TOTAL=${RUN_RATIO#*/}
    if [ "$RUN_TOTAL" -gt 0 ] && [ "$RUN_PASSED" = "$RUN_TOTAL" ]; then
      echo "$RUN_MARKER"
      return 0
    fi
    echo "✗ 失败（成功 marker 不是全绿：${RUN_MARKER}）"
  elif [ "$RUN_STATUS" -eq 0 ]; then
    echo "✗ 失败（缺少唯一成功 marker，实际 $RUN_MARKER_COUNT 个）"
  else
    echo "✗ 失败（exit ${RUN_STATUS}）"
  fi
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
  fi
  FAILED=1
}

run "越权用例全拒"        scripts/verify-authz.mjs
run "上线前安全验收"      scripts/verify-security.mjs
run "安全基线 7 组对照"   scripts/verify-baseline.mjs
run "企业代理出网"        scripts/verify-proxy-egress.mjs
run "离线安装包"          scripts/verify-offline.mjs
run "容器参数白名单"      scripts/verify-container-guard.mjs
run "实例创建 根路径"      scripts/verify-instance.mjs
run "实例创建 子路径"      scripts/verify-instance.mjs /nodered
run "反代端到端 根路径"    scripts/verify-proxy.mjs
run "反代端到端 子路径"    scripts/verify-proxy.mjs /nodered
run "实例 CRUD API"        scripts/verify-api.mjs
run "实例版本升级"        scripts/verify-upgrade.mjs
run "健康探针"             scripts/verify-health.mjs
run "实例间网络隔离"       scripts/verify-isolation.mjs
run "Manager 容器化 根路径" scripts/verify-container.mjs
run "Manager 容器化 子路径" scripts/verify-container.mjs /nodered
run "docker-compose 部署"  scripts/verify-compose.mjs
run "虚拟网关 云边上下行"  scripts/verify-cloud-gateway.mjs
run "云对接整条链路"      scripts/verify-cloud-link.mjs
run "远程诊断导出"        scripts/verify-diag.mjs
run "流程模板导入套用"    scripts/verify-template.mjs
run "节点白名单与私有源"  scripts/verify-nodes.mjs
run "平台 npm 节点迁移"   scripts/verify-platform-nodes.mjs
run "云对接 TLS 证书"      scripts/verify-cloud-tls.mjs
run "首次设置"            scripts/verify-setup.mjs
run "系统设置与两步验证"  scripts/verify-2fa.mjs

echo ""
echo "── 残留检查 ──"
AFTER_C=$(mktemp)
AFTER_V=$(mktemp)
AFTER_N=$(mktemp)
snapshot_docker_resources containers "$AFTER_C"
snapshot_docker_resources volumes "$AFTER_V"
snapshot_docker_resources networks "$AFTER_N"
LEFT=$(comm -13 "$BEFORE_C" "$AFTER_C" | wc -l | tr -d ' ')
VOLS=$(comm -13 "$BEFORE_V" "$AFTER_V" | wc -l | tr -d ' ')
NETS=$(comm -13 "$BEFORE_N" "$AFTER_N" | wc -l | tr -d ' ')
LOST_C=$(comm -23 "$BEFORE_C" "$AFTER_C" | wc -l | tr -d ' ')
LOST_V=$(comm -23 "$BEFORE_V" "$AFTER_V" | wc -l | tr -d ' ')
LOST_N=$(comm -23 "$BEFORE_N" "$AFTER_N" | wc -l | tr -d ' ')
if [ "$LEFT" = 0 ] && [ "$VOLS" = 0 ] && [ "$NETS" = 0 ] \
    && [ "$LOST_C" = 0 ] && [ "$LOST_V" = 0 ] && [ "$LOST_N" = 0 ]; then
  echo "  新增容器 0 · 卷 0 · 网络 0  （干净）"
  echo "  丢失容器 0 · 卷 0 · 网络 0  （基线完整）"
else
  if [ "$LEFT" != 0 ] || [ "$VOLS" != 0 ] || [ "$NETS" != 0 ]; then
    echo "  新增容器 $LEFT · 卷 $VOLS · 网络 $NETS  ✗ 有残留"
  fi
  if [ "$LOST_C" != 0 ] || [ "$LOST_V" != 0 ] || [ "$LOST_N" != 0 ]; then
    echo "  丢失容器 $LOST_C · 卷 $LOST_V · 网络 $LOST_N  ✗ 基线被改动"
  fi
  FAILED=1
fi

if ! cleanup_task_tags; then
  FAILED=1
fi

echo ""
[ "$FAILED" = 0 ] && echo "════════ 全部通过 ════════" || { echo "════════ 存在失败 ════════"; exit 1; }
echo ""
