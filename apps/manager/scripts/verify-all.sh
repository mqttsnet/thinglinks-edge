#!/bin/sh
# 全量回归 —— 每次改动后必须全绿。回归只增不减。
#
# 用法： pnpm verify
set -e
cd "$(dirname "$0")/.."

echo ""
echo "════════ ThingLinks Edge · 全量回归 ════════"
echo ""

echo "── 单元测试 ──"
pnpm test 2>&1 | grep -E "^# (tests|pass|fail)" | sed 's/^/  /'
echo ""

echo "── 类型与构建 ──"
pnpm typecheck >/dev/null 2>&1 && echo "  typecheck ✓" || { echo "  typecheck ✗"; exit 1; }
pnpm build >/dev/null 2>&1 && echo "  build ✓" || { echo "  build ✗"; exit 1; }
echo ""

echo "── 真容器验证 ──"
FAILED=0
run() {
  name="$1"; shift
  printf "  %-30s " "$name"
  if out=$(node "$@" 2>&1); then
    echo "$(echo "$out" | grep -oE '[0-9]+/[0-9]+ 通过' | tail -1)"
  else
    echo "✗ 失败"
    echo "$out" | tail -6 | sed 's/^/      /'
    FAILED=1
  fi
}

run "容器参数白名单"      scripts/verify-container-guard.mjs
run "实例创建 根路径"      scripts/verify-instance.mjs
run "实例创建 子路径"      scripts/verify-instance.mjs /nodered
run "反代端到端 根路径"    scripts/verify-proxy.mjs
run "反代端到端 子路径"    scripts/verify-proxy.mjs /nodered
run "实例 CRUD API"        scripts/verify-api.mjs
run "健康探针"             scripts/verify-health.mjs
run "实例间网络隔离"       scripts/verify-isolation.mjs

echo ""
echo "── 残留检查 ──"
LEFT=$(docker ps -aq --filter "name=tle-" | wc -l | tr -d ' ')
VOLS=$(docker volume ls -q --filter "name=tle-nr-" | wc -l | tr -d ' ')
NETS=$(docker network ls -q --filter "label=com.mqttsnet.thinglinks-edge.managed=true" | wc -l | tr -d ' ')
echo "  容器 $LEFT · 卷 $VOLS · 网络 $NETS  $([ "$LEFT$VOLS$NETS" = "000" ] && echo '（干净）' || echo '⚠ 有残留')"

echo ""
[ "$FAILED" = "0" ] && echo "════════ 全部通过 ════════" || { echo "════════ 存在失败 ════════"; exit 1; }
echo ""
