/**
 * 离线安装包验证（T6.3）。
 *
 * 验收原文：「**断开外网**完成全新安装并创建实例」。
 *
 * 怎么在没法真拔网线的机器上证明「断网也能装」——
 * 把平台三个镜像**改名成互联网上不存在的仓库名**再打包，打完从本机删掉那几个标签。
 * 于是安装过程若有任何一步想去网上拉，必然失败（那个名字谁都没有）；
 * 装成功就只可能是从包里 load 出来的。这比「断网跑一次」更强：
 * 它对**每次**运行都成立，不依赖跑验证时机器恰好没网。
 *
 * 实例镜像保持真名：Manager 建实例时本来就**不会拉镜像**
 * （assertImagePresent 直接报错并教人 docker save/load），
 * 那条离线保证由产品结构提供，这里只验它确实随包发出去了、且真能建出实例。
 */
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TEST_EDGE_ROOT, resetRoot, resetDataDir } from './_data-root.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PREFIX = 'tle-off';
const PROJECT = 'tle-offline-verify';
const PORT = 13277;
const B = `http://127.0.0.1:${PORT}`;
const TAG = '5.0.4-24-minimal';
const NODE_RED = `nodered/node-red:${TAG}`;
const ID = 'off-a';
const SETUP_PW = 'offline-verify-pass-01';

/** 互联网上不存在的仓库名：任何一次拉取尝试都会失败 —— 这正是我们要的 */
const FAKE = {
  manager: 'tle-offline-verify.invalid/manager:probe',
  proxy: 'tle-offline-verify.invalid/socket-proxy:probe',
  init: 'tle-offline-verify.invalid/init:probe',
};

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO, ...opts });

let workDir = '';

async function cleanup() {
  /*
   * 按**容器名**清，不按 compose 项目清。
   *
   * install.sh 不带 -p，项目名由它所在的临时目录派生（每次都不一样），
   * 拿一个固定的 PROJECT 去 down 是清不掉上一轮的 —— 上一轮的容器还占着名字，
   * 下一轮 up 直接报 name is already in use，而那句话看起来像 compose 的毛病。
   */
  for (const c of [`${PREFIX}-manager`, `${PREFIX}-docker-proxy`, `${PREFIX}-init-data`]) {
    await raw.getContainer(c).remove({ force: true, v: true }).catch(() => {});
  }
  await raw.getNetwork(`${PREFIX}-docker`).remove().catch(() => {});
  await raw.getContainer(`tle-nr-${ID}`).remove({ force: true }).catch(() => {});
  await resetDataDir(ID);
  for (const img of Object.values(FAKE)) {
    try { sh('docker', ['rmi', '-f', img], { stdio: 'pipe' }); } catch { /* 没有就算了 */ }
  }
  const nets = await raw.listNetworks({ filters: { name: [`${PREFIX}-`] } }).catch(() => []);
  for (const n of nets) await raw.getNetwork(n.Id).remove().catch(() => {});
}

async function main() {
  console.log('\n──── 离线安装包 · 断网安装验证 ────\n');
  await resetRoot();
  await cleanup();

  const version = JSON.parse(readFileSync(join(REPO, 'apps/manager/package.json'), 'utf8')).version;
  const realManager = process.env.MANAGER_IMAGE ?? `mqttsnet/thinglinks-edge:${version}`;
  const arch = sh('docker', ['version', '--format', '{{.Server.Arch}}']).trim();

  for (const [src, dst] of [
    [realManager, FAKE.manager],
    ['wollomatic/socket-proxy:1.13.1', FAKE.proxy],
    ['alpine:3.22', FAKE.init],
  ]) {
    try { sh('docker', ['tag', src, dst]); } catch {
      throw new Error(`本机缺少镜像 ${src}，先构建/拉取后再跑：`
        + 'docker compose -f docker-compose.yml -f docker-compose.build.yml build');
    }
  }

  // ── 1. 打包 ────────────────────────────────────────────
  const outDir = mkdtempSync(join(tmpdir(), 'tle-bundle-'));
  sh('./scripts/build-offline-bundle.sh', ['--out', outDir], {
    env: {
      ...process.env,
      MANAGER_IMAGE: FAKE.manager, PROXY_IMAGE: FAKE.proxy, INIT_IMAGE: FAKE.init,
      ALLOWED_IMAGE_TAGS: TAG,
    },
    stdio: 'pipe',
  });
  const bundle = join(outDir, `thinglinks-edge-offline-${version}-linux-${arch}.tar.gz`);
  check('打包产出一个带版本与架构的 tar.gz', existsSync(bundle),
        `${(sh('du', ['-h', bundle]).split('\t')[0] ?? '?').trim()} · ${bundle.split('/').pop()}`);

  // ── 2. 解开并核对包内容 ────────────────────────────────
  // 解到一个空目录里，模拟现场「拷过去解开就装」
  workDir = mkdtempSync(join(tmpdir(), 'tle-install-'));
  sh('tar', ['-xzf', bundle, '-C', workDir, '--strip-components', '1']);

  for (const f of ['images.tar', 'docker-compose.yml', 'docker-compose.offline.yml',
                   'install.sh', 'manifest.json', 'SHA256SUMS', '.env.example', 'README.md']) {
    if (!existsSync(join(workDir, f))) throw new Error(`包里缺 ${f}`);
  }
  check('包内含镜像、compose、离线覆盖、安装脚本、清单、校验和、说明', true);

  const manifest = JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf8'));
  check('清单写明架构，装错架构时能当场拦住', manifest.platform === `linux/${arch}`, manifest.platform);
  const listed = manifest.images.map((i) => i.image);
  check('平台三件套与实例镜像都在包里',
        [FAKE.manager, FAKE.proxy, FAKE.init, NODE_RED].every((i) => listed.includes(i)),
        listed.join(' '));

  const sums = sh('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: workDir, stdio: 'pipe' });
  check('校验和自洽（U 盘拷坏的包能当场发现）', sums.includes('images.tar: OK'));

  // ── 3. 断网条件：把这几个标签从本机删干净 ──────────────
  for (const img of Object.values(FAKE)) sh('docker', ['rmi', '-f', img], { stdio: 'pipe' });
  const gone = Object.values(FAKE).every((img) => {
    try { sh('docker', ['image', 'inspect', img], { stdio: 'pipe' }); return false; }
    catch { return true; }
  });
  check('安装前本机没有这三个镜像，且互联网上也不存在同名仓库', gone);

  // ── 4. 安装 ────────────────────────────────────────────
  writeFileSync(join(workDir, '.env'), [
    `EXTERNAL_URL=${B}`,
    'MASTER_KEY=offline-verify-master-key-0123456789',
    `MANAGER_IMAGE=${FAKE.manager}`,
    `PROXY_IMAGE=${FAKE.proxy}`,
    `INIT_IMAGE=${FAKE.init}`,
    'DOCKER_GID=0',
    'BIND_ADDR=127.0.0.1',
    `HOST_PORT=${PORT}`,
    `INSTANCE_NETWORK=${PREFIX}-net`,
    `ALLOWED_IMAGE_TAGS=${TAG}`,
    `EDGE_DATA_ROOT=${TEST_EDGE_ROOT}`,
    `EDGE_NAME_PREFIX=${PREFIX}`,
    'INSTANCE_PORT_MIN=31500',
    'INSTANCE_PORT_MAX=31599',
  ].join('\n') + '\n');

  console.log('  · ./install.sh --yes …');
  const installLog = sh('./install.sh', ['--yes'], { cwd: workDir, stdio: 'pipe' });
  check('install.sh 一把跑通（校验 → load → 起服务 → 等健康）',
        installLog.includes('完成'), installLog.trim().split('\n').slice(-1)[0]?.slice(0, 60));
  check('安装过程没有出现任何拉取动作', !/Pulling|Pull complete|pulling from/i.test(installLog));

  const loaded = Object.values(FAKE).every((img) => {
    try { sh('docker', ['image', 'inspect', img], { stdio: 'pipe' }); return true; }
    catch { return false; }
  });
  check('镜像确实来自包内（这几个名字在任何 registry 上都拉不到）', loaded);

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(500);
    ready = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('装完 Manager 就绪并可访问', ready, ready ? B : '超时');
  if (!ready) throw new Error('离线安装后 Manager 未就绪');

  // ── 5. 全新安装的首次设置与建实例 ──────────────────────
  const state = await (await fetch(`${B}/api/setup`)).json();
  check('全新安装进入「首次设置」状态，而不是留一个默认口令', state.needed === true);

  const setupRes = await fetch(`${B}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
  });
  const cookie = (setupRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  check('设置管理员后直接拿到会话', setupRes.status === 200 && Boolean(csrf), `HTTP ${setupRes.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: '离线验证', imageTag: TAG, memoryMb: 256, cpus: 0.5, ports: [] }),
  });
  const createdBody = created.status === 201 ? '' : (await created.text()).slice(0, 200);
  check('断网条件下能创建实例（验收的核心一条）', created.status === 201,
        `HTTP ${created.status} ${createdBody}`);
  if (created.status !== 201) {
    // 失败时把现场信息一次性打全 —— 只报一句 400 的话，
    // 下次还得再跑一遍五分钟的验证才能知道是谁的问题
    console.log('    ── 排障信息 ──');
    console.log(sh('docker', ['ps', '-a', '--filter', `name=${PREFIX}-`,
      '--format', '      {{.Names}} | {{.Image}} | {{.Status}}']));
    for (const c of [`${PREFIX}-docker-proxy`, `${PREFIX}-manager`]) {
      const log = await raw.getContainer(c).logs({ stdout: true, stderr: true, tail: 8 })
        .then((b) => b.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, ''))
        .catch((e) => `取不到日志：${e.message}`);
      console.log(`    ${c}:\n${log.split('\n').map((l) => '      ' + l).join('\n')}`);
    }
  }

  const inst = await raw.getContainer(`tle-nr-${ID}`).inspect().catch(() => undefined);
  check('实例容器真的起来了', inst?.State?.Running === true, inst?.State?.Status ?? '不存在');

  const outOfBundle = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: 'off-b', name: '不在包里', imageTag: '4.1.13-22-minimal',
                           memoryMb: 256, cpus: 0.5, ports: [] }),
  });
  const msg = (await outOfBundle.json()).error ?? '';
  check('选包外版本时当场拒绝并说明可选项，而不是卡在拉镜像',
        outOfBundle.status === 400 && msg.includes(TAG), msg.slice(0, 70));

  rmSync(outDir, { recursive: true, force: true });
  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n验证失败：', e.message);
  await cleanup();
  process.exit(1);
});
