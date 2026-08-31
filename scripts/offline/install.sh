#!/usr/bin/env bash
#
# 现场离线安装（T6.3）。这个脚本会被打进离线包，在**没有外网**的机器上跑。
#
#   ./install.sh              # 交互式：缺什么问什么
#   ./install.sh --yes        # 非交互：变量必须已在 .env 里配好
#
# 它做五件事，每件都先检查再动手：
#   1. 校验包完整（U 盘拷贝坏一半的包，load 时报的是 unexpected EOF，看不出是文件坏了）
#   2. 把镜像 load 进本机 docker
#   3. 备好 .env（MASTER_KEY 现场生成，绝不预置在包里）
#   4. 把随包的预置节点包放进数据目录（包里带了才做）
#   5. 起服务，并等到健康检查通过才算成功
#
set -euo pipefail
cd "$(dirname "$0")"

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "本机没有 docker。离线包不含 docker 本体，请先装好 docker 再来"
docker info >/dev/null 2>&1 || die "docker 守护进程没起来： systemctl start docker"
docker compose version >/dev/null 2>&1 || die "docker compose 插件缺失（需要 v2）"

# ── 1. 完整性 ────────────────────────────────────────────
say "── 校验安装包 ──"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS >/dev/null || die "校验和不匹配：包在传输中损坏了，请重新拷贝"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS >/dev/null || die "校验和不匹配：包在传输中损坏了，请重新拷贝"
else
  say "  ⚠ 本机没有 shasum/sha256sum，跳过校验（不建议）"
fi

PKG_ARCH="$(node -p "require('./manifest.json').platform" 2>/dev/null || grep -o '"platform": *"[^"]*"' manifest.json | cut -d'"' -f4)"
HOST_ARCH="linux/$(docker version --format '{{.Server.Arch}}')"
[ "$PKG_ARCH" = "$HOST_ARCH" ] || die "包是 ${PKG_ARCH}，本机是 ${HOST_ARCH} —— 装上去容器会报 exec format error，请换对应架构的包"
say "  ✓ 完整性与架构（${PKG_ARCH}）"

# ── 2. 装镜像 ────────────────────────────────────────────
say ""
say "── 导入镜像 ──"
docker load -i images.tar | sed 's/^/  /'

# ── 3. 配置 ──────────────────────────────────────────────
say ""
say "── 配置 ──"
if [ ! -f .env ]; then
  cp .env.example .env
  say "  已从模板生成 .env"
fi

# MASTER_KEY 必须现场生成：预置在包里等于所有客户共用一把密钥，
# 那还不如不加密 —— 它保护的是实例凭据与备份
if ! grep -q '^MASTER_KEY=.\+' .env; then
  KEY="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ -n "$KEY" ] || die "生成 MASTER_KEY 失败：本机既没有 openssl 也读不到 /dev/urandom"
  # BSD 与 GNU 的 sed -i 参数不同，直接重写整行更省事
  grep -v '^MASTER_KEY=' .env > .env.tmp && printf 'MASTER_KEY=%s\n' "$KEY" >> .env.tmp && mv .env.tmp .env
  chmod 600 .env
  say "  ✓ 已生成 MASTER_KEY（在 .env 里，请与数据目录一起备份，丢了实例凭据解不开）"
fi

if ! grep -q '^EXTERNAL_URL=.\+' .env; then
  if [ "$ASSUME_YES" = "1" ]; then
    die "EXTERNAL_URL 未配置。非交互安装请先在 .env 里填好，例如 EXTERNAL_URL=http://192.168.10.20:19100"
  fi
  say ""
  say "  外部访问地址：现场用什么地址访问这台机器？"
  say "  例：http://192.168.10.20:19100 （无域名就填 IP）"
  printf '  EXTERNAL_URL= '
  read -r URL
  [ -n "$URL" ] || die "EXTERNAL_URL 不能为空 —— 所有对外链接、跳转与 Cookie 策略都由它派生"
  grep -v '^EXTERNAL_URL=' .env > .env.tmp && printf 'EXTERNAL_URL=%s\n' "$URL" >> .env.tmp && mv .env.tmp .env
fi

# ── 4. 预置节点包（01 号文 5.7）─────────────────────────
#
# 拷进 <EDGE_DATA_ROOT>/manager/npm-seed/，Manager 启动时自动扫进私有源。
#
# **必须用容器来拷，不能直接 cp**：数据目录属主是 uid 1000（compose 的
# init-data 摆平的），而跑 install.sh 的人未必有权限往那儿写，更不该
# 为了这一步去 sudo。借用包里已经有的 alpine 镜像做一次性拷贝，
# 之后 init-data 的 chown -R 会把属主一并理顺。
#
# 顺序也要紧：必须在 compose up **之前**做完，否则 Manager 已经扫过一遍了。
if [ -d node-seed ]; then
  say ""
  say "── 预置节点包 ──"
  DATA_ROOT="$(grep '^EDGE_DATA_ROOT=' .env 2>/dev/null | cut -d= -f2- || true)"
  DATA_ROOT="${DATA_ROOT:-/data01/mqttsnet/thinglinks-edge}"
  INIT_IMG="$(grep '^INIT_IMAGE=' .env 2>/dev/null | cut -d= -f2- || true)"
  INIT_IMG="${INIT_IMG:-alpine:3.22}"
  COUNT="$(find node-seed -name '*.tgz' | wc -l | tr -d ' ')"
  docker run --rm \
    -v "${DATA_ROOT}:/data-root" \
    -v "$(pwd)/node-seed:/seed:ro" \
    "$INIT_IMG" \
    sh -c 'mkdir -p /data-root/manager/npm-seed && cp /seed/*.tgz /data-root/manager/npm-seed/' \
    || die "预置节点包拷贝失败（数据目录 ${DATA_ROOT} 可写吗？）"
  say "  ✓ ${COUNT} 个节点包已放进 ${DATA_ROOT}/manager/npm-seed/"
  # 说清楚下一步：进了库不等于能装，批准是管理员在控制台的动作
  say "  · 它们只是「有得装」；要在控制台『节点管理』里批准后才允许安装"
fi

# ── 5. 起服务 ────────────────────────────────────────────
say ""
say "── 启动 ──"
# offline 覆盖层让「镜像没 load 进去」当场失败，而不是去连网拉
docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d

say ""
printf '  等待健康检查'
for _ in $(seq 1 60); do
  state="$(docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep manager || true)"
  case "$state" in
    *healthy*) say ""; say "  ✓ ${state}"; break ;;
  esac
  printf '.'
  sleep 2
done

say ""
say "── 完成 ──"
say "  控制台： $(grep '^EXTERNAL_URL=' .env | cut -d= -f2-)"
say "  首次打开会让你设置管理员账号与口令。"
say ""
if [ -d node-seed ]; then
  # 不在这里逐个列名字：一个节点包连着十几个依赖包，列出来是几十行噪音。
  # 哪些是**节点**、哪些只是依赖，控制台那一页分得清清楚楚。
  say "  随包带了 ${COUNT} 个节点包（含依赖）。到控制台『节点管理』里批准后才能安装。"
  say ""
fi
say "  实例镜像已随包装好，创建实例时可直接选："
grep -o '"nodered/node-red:[^"]*"' manifest.json | tr -d '"' | sed 's/^/    /'
say ""
say "  自检（建议装完跑一次）： docker compose exec manager node dist/index.js preflight"
