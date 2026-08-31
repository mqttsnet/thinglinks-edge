#!/usr/bin/env bash
#
# 把若干 Node-RED 节点包**连同依赖闭包**打成一堆 .tgz，供离线现场预置（01 号文 5.7）。
#
#   ./scripts/pack-nodes.sh node-red-contrib-modbus node-red-node-serialport
#   ./scripts/pack-nodes.sh --out /tmp/seed node-red-contrib-s7
#
# 产出目录里全是 .tgz，直接拷进现场的 <EDGE_DATA_ROOT>/manager/npm-seed/ 重启即可，
# 或者由 build-offline-bundle.sh 随离线包一起发。
#
# **为什么必须带依赖闭包**：只放节点包本身，现场点安装时 npm 会去公网找它的依赖，
# 而现场没有公网 —— 表现是「包明明在源里，还是装不上」，报错还只说某个依赖 404。
# 这个脚本存在的全部理由就是把这一步做对。
#
# 打包机需要外网（它就是去公网取包的），现场机器不需要。
#
# ## 闭包从 .package-lock.json 取，不从 node_modules 目录扫（实测踩过）
#
# 拿 node-red-contrib-modbus 5.60.2 实测：扫顶层 node_modules 得 36 个包，
# 而 lock 文件里是 52 个。差的那 16 个是**嵌套的不同版本** ——
# `@openp4nr/modbus-serial/node_modules/serialport@10.5.0` 与顶层被提升的
# `serialport@13.0.0` 是两个都要带的包。只扫目录顶层会漏掉前者，
# 现场表现是「装到一半说某个包的某个版本找不到」。
#
# lock 文件还顺带解决另外两件事：
#
#   · 每条都带 `resolved` 真实下载地址。有的包把依赖写成 tarball URL
#     （modbus 的 @openp4nr/modbus-serial 就指向 cloudsmith），
#     那种包 `npm pack <名字>@<版本>` 取不到 —— 任何 registry 里都没有它。
#   · 每条都带 `integrity`，下完能当场核对，而不是等现场装的时候才发现拷坏了。
set -euo pipefail

OUT_DIR="dist-nodes"
PKGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT_DIR="${1:?--out 后面要跟目录}" ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) PKGS+=("$1") ;;
  esac
  shift
done

[ ${#PKGS[@]} -gt 0 ] || { echo "用法：$0 [--out 目录] <包名>..." >&2; exit 2; }

command -v npm >/dev/null || { echo "✗ 需要 npm" >&2; exit 1; }
command -v curl >/dev/null || { echo "✗ 需要 curl（按 lock 里的 resolved 地址取包体）" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

echo "── 解析依赖闭包 ──"
printf '  %s\n' "${PKGS[@]}"
echo

# 1) 先装一遍，让 npm 自己把闭包解出来。
#    --ignore-scripts：我们只要清单，不要在打包机上跑陌生包的安装脚本
echo '{"name":"tle-node-seed","version":"1.0.0","private":true}' > "$WORK/package.json"
( cd "$WORK" && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    --loglevel=error -- "${PKGS[@]}" ) || { echo "✗ 依赖解析失败" >&2; exit 1; }

LOCK="$WORK/node_modules/.package-lock.json"
[ -f "$LOCK" ] || { echo "✗ npm 没有生成 $LOCK —— 无法确定闭包" >&2; exit 1; }

# 2) 从 lock 文件里列出闭包：每行 `<name>\t<version>\t<resolved>\t<integrity>`。
#    见文件头「闭包从 .package-lock.json 取」——嵌套的重复版本必须一个不漏。
RESOLVED="$(node -e '
const lock = require(process.argv[1]);
const seen = new Set();
const out = [];
for (const [path, e] of Object.entries(lock.packages ?? {})) {
  if (path === "" || e.link || e.dev) continue;          // 根条目、软链、devDep 都不要
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const name = e.name ?? path.slice(at + "node_modules/".length);
  if (!e.version || !e.resolved) continue;               // 没有下载地址就打不了包
  const key = `${name}@${e.version}`;
  if (seen.has(key)) continue;                           // 同名同版本在树里会出现多次
  seen.add(key);
  out.push([name, e.version, e.resolved, e.integrity ?? ""].join("\t"));
}
console.log(out.sort().join("\n"));
' "$LOCK")"

COUNT="$(printf '%s\n' "$RESOLVED" | grep -c . || true)"
echo "  闭包共 ${COUNT} 个包"
echo

# 3) 逐个取**已发布的原始 tarball**，直接下 lock 里的 resolved 地址 ——
#    而不是把 node_modules 里的目录重新打包。重新打包会因为 files/.npmignore
#    的处理差异产生与上游不一致的内容，内容一变校验值就对不上上游，
#    将来想核对来源就无从下手。下完立刻按 integrity 核对。
echo "── 下载包体 ──"
cd "$OUT_DIR"
FAIL=0
while IFS="$(printf '\t')" read -r name version url integrity; do
  [ -n "$name" ] || continue
  # 与 npm pack 同款文件名：去掉 scope 的 @、把斜杠换成连字符
  file="$(printf '%s' "$name" | sed 's|^@||; s|/|-|g')-${version}.tgz"
  if ! curl -fsSL --retry 2 -o "$file" -- "$url"; then
    echo "  ✗ ${name}@${version}  取不到： $url" >&2
    rm -f "$file"
    FAIL=$((FAIL + 1))
    continue
  fi
  if [ -n "$integrity" ] && ! node -e '
    const { createHash } = require("node:crypto");
    const [file, integrity] = process.argv.slice(1);
    // SRI 可以并列多个值（空格分隔），核对第一个就够；
    // 用 indexOf 切而不是 split("-")，base64 里出现连字符时 split 会截断
    const first = integrity.trim().split(/\s+/)[0];
    const dash = first.indexOf("-");
    const algo = first.slice(0, dash);
    const expect = first.slice(dash + 1);
    const got = createHash(algo).update(require("node:fs").readFileSync(file)).digest("base64");
    process.exit(got === expect ? 0 : 1);
  ' "$file" "$integrity"; then
    echo "  ✗ ${name}@${version}  校验值不符（下坏了或上游被改过）" >&2
    rm -f "$file"
    FAIL=$((FAIL + 1))
    continue
  fi
  echo "  ✓ ${name}@${version}"
done <<< "$RESOLVED"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "✗ 有 ${FAIL} 个包没取到 —— 缺包的种子目录到现场会装不上，请先解决" >&2
  exit 1
fi
echo "  ✓ $(ls -1 *.tgz 2>/dev/null | wc -l | tr -d ' ') 个 .tgz 已放在 ${OUT_DIR}/"
echo
echo "  用法一（随离线包发）： NODE_SEED_DIR=$(pwd) ./scripts/build-offline-bundle.sh"
echo "  用法二（现场直接放）： 拷进 <EDGE_DATA_ROOT>/manager/npm-seed/ 后重启 manager"
echo
