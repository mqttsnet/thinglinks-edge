#!/usr/bin/env bash
#
# 现场离线安装（T6.3）。这个脚本会被打进离线包，在**没有外网**的机器上跑。
#
#   ./install.sh              # 交互式：缺什么问什么
#   ./install.sh --yes        # 非交互：变量必须已在 .env 里配好
#
# 它做四件事，每件都先检查再动手：
#   1. 校验包完整（U 盘拷贝坏一半的包，load 时报的是 unexpected EOF，看不出是文件坏了）
#   2. 把镜像 load 进本机 docker
#   3. 备好 .env（MASTER_KEY 现场生成，绝不预置在包里）
#   4. 起服务，并等到健康检查通过才算成功
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

# ── 4. 起服务 ────────────────────────────────────────────
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
say "  实例镜像已随包装好，创建实例时可直接选："
grep -o '"nodered/node-red:[^"]*"' manifest.json | tr -d '"' | sed 's/^/    /'
say ""
say "  自检（建议装完跑一次）： docker compose exec manager node dist/index.js preflight"
