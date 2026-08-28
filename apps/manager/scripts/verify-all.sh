#!/bin/sh
# 全量回归 —— 每次改动后必须全绿。回归只增不减。
#
# 用法： pnpm verify
set -e
cd "$(dirname "$0")/.."

echo ""
echo "════════ ThingLinks Edge · 全量回归 ════════"
echo ""

# 跑之前先拍一张快照，收尾时只比差集
BEFORE_C=$(mktemp); BEFORE_V=$(mktemp); BEFORE_N=$(mktemp)
docker ps -aq --filter "name=tle-" | sort > "$BEFORE_C"
docker volume ls -q --filter "name=tle-nr-" | sort > "$BEFORE_V"
docker network ls -q --filter "label=com.mqttsnet.thinglinks-edge.managed=true" | sort > "$BEFORE_N"

echo "── 单元测试 ──"
printf "  manager  "
pnpm test 2>&1 | grep -E "^# (tests|pass|fail)" | tr '\n' ' ' | sed 's/# //g'
echo ""
# 控制台也有单测（时间戳按 UTC 解析、文件名 RFC 5987、broker 地址拼装 …）。
# 这些逻辑一旦回归，界面上是「时间差 8 小时」「文件名成一串下划线」这类
# 不报错的错，构建和类型检查一律看不出来 —— 所以必须跑在同一道闸门里。
printf "  console  "
pnpm --filter @thinglinks-edge/web-console test 2>&1 \
  | grep -E "^# (tests|pass|fail)" | tr '\n' ' ' | sed 's/# //g'
echo ""
echo ""

echo "── 类型与构建 ──"
pnpm typecheck >/dev/null 2>&1 && echo "  manager typecheck ✓" || { echo "  manager typecheck ✗"; exit 1; }
pnpm build >/dev/null 2>&1 && echo "  manager build ✓" || { echo "  manager build ✗"; exit 1; }
# 控制台构建即类型检查（build 脚本是 vue-tsc --noEmit && vite build）
pnpm --filter @thinglinks-edge/web-console build >/dev/null 2>&1 \
  && echo "  console 构建 ✓" || { echo "  console 构建 ✗"; exit 1; }
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

run "越权用例全拒"        scripts/verify-authz.mjs
run "容器参数白名单"      scripts/verify-container-guard.mjs
run "实例创建 根路径"      scripts/verify-instance.mjs
run "实例创建 子路径"      scripts/verify-instance.mjs /nodered
run "反代端到端 根路径"    scripts/verify-proxy.mjs
run "反代端到端 子路径"    scripts/verify-proxy.mjs /nodered
run "实例 CRUD API"        scripts/verify-api.mjs
run "健康探针"             scripts/verify-health.mjs
run "实例间网络隔离"       scripts/verify-isolation.mjs
run "Manager 容器化 根路径" scripts/verify-container.mjs
run "Manager 容器化 子路径" scripts/verify-container.mjs /nodered
run "docker-compose 部署"  scripts/verify-compose.mjs
run "虚拟网关 云边上下行"  scripts/verify-cloud-gateway.mjs
run "云对接整条链路"      scripts/verify-cloud-link.mjs
run "远程诊断导出"        scripts/verify-diag.mjs
run "流程模板导入套用"    scripts/verify-template.mjs
run "云对接 TLS 证书"      scripts/verify-cloud-tls.mjs

echo ""
echo "── 残留检查 ──"
# 只数**本次新增**的：同一台机器上可能正跑着现场的实例，
# 按前缀数会把它们误报成残留，那会训练出「残留告警不用看」的坏习惯
# 本脚本用 sh 跑，没有进程替换，一律落临时文件再比
AFTER_C=$(mktemp); AFTER_V=$(mktemp); AFTER_N=$(mktemp)
docker ps -aq --filter "name=tle-" | sort > "$AFTER_C"
docker volume ls -q --filter "name=tle-nr-" | sort > "$AFTER_V"
docker network ls -q --filter "label=com.mqttsnet.thinglinks-edge.managed=true" | sort > "$AFTER_N"
LEFT=$(comm -13 "$BEFORE_C" "$AFTER_C" | wc -l | tr -d ' ')
VOLS=$(comm -13 "$BEFORE_V" "$AFTER_V" | wc -l | tr -d ' ')
NETS=$(comm -13 "$BEFORE_N" "$AFTER_N" | wc -l | tr -d ' ')
rm -f "$BEFORE_C" "$BEFORE_V" "$BEFORE_N" "$AFTER_C" "$AFTER_V" "$AFTER_N"
echo "  新增容器 $LEFT · 卷 $VOLS · 网络 $NETS  $([ "$LEFT$VOLS$NETS" = "000" ] && echo '（干净）' || echo '⚠ 有残留')"

echo ""
[ "$FAILED" = "0" ] && echo "════════ 全部通过 ════════" || { echo "════════ 存在失败 ════════"; exit 1; }
echo ""
