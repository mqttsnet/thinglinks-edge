/**
 * docker-compose 部署验证 —— 只验 compose 这一层特有的风险，
 * 实例生命周期与反代已由 verify-container.mjs 覆盖，不重复。
 *
 * compose 特有的坑：
 *   · 必填变量缺失时应当**拒绝启动**，而不是带着空值跑起来
 *   · 容器 hostname 不是容器名，MANAGER_CONTAINER 若依赖回退，
 *     换个编排方式就会接入失败 —— 表现是反代 502、健康页应用层不通，
 *     而 Manager 本身「看起来正常」
 *   · read_only 根文件系统开启后进程仍须能正常读写数据目录
 *   · Manager 不得再挂宿主 docker.sock，所有 docker 调用必须经受限代理，
 *     且代理的白名单要「够用又不多给」—— 够用由整条生命周期跑通反证，
 *     不多给由逐条探测被拒的端点正面证明
 */
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TEST_EDGE_ROOT, TEST_DATA_ROOT, ensureRoot, resetRoot, resetDataDir } from './_data-root.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'tle-compose-verify';
/*
 * 用独立的名字前缀，好让验证能在「现场栈正开着」时照跑。
 * compose 的 container_name 是固定值，不参数化就会撞名 ——
 * 而「跑验证前要先停掉现场」是个不该存在的约束。
 */
const PREFIX = 'tle-cv';
const MGR = `${PREFIX}-manager`;
const PROXY = `${PREFIX}-docker-proxy`;
const NET = 'tle-cv-net';
const PORT = 13211;
/** 首次设置时现场指定的口令。这一串**不该出现在任何日志里** */
const SETUP_PW = 'compose-verify-pass-01';
const ID = 'cv-a';
const TAG = '5.0.4-24-minimal';
const B = `http://127.0.0.1:${PORT}`;

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', cwd: REPO, ...opts });

const envFile = join(mkdtempSync(join(tmpdir(), 'tle-compose-')), '.env');
/*
 * 显式叠加构建覆盖文件。docker-compose.yml 主文件已改成「纯拉取」
 * （image 指向 Docker Hub 上的公开镜像，没有 build 段）—— 那是现场部署要的形态。
 * 但验证要证明的是**本地这份源码**能跑起来，不是线上镜像能跑起来：
 * 不加这两个 -f，`up --build` 会因为没有 build 段而静默跳过构建、
 * 转去拉线上镜像，于是验证全绿而你的改动根本没被执行过。
 */
const FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.build.yml'];
const compose = (...args) => sh(['compose', '-p', PROJECT, ...FILES, '--env-file', envFile, ...args], { stdio: 'pipe' });

function socketGid() {
  return sh(['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    'alpine', 'stat', '-c', '%g', '/var/run/docker.sock']).trim();
}

async function cleanup() {
  try { compose('down', '-v', '--remove-orphans'); } catch { /* 未起过 */ }
  await raw.getContainer(`tle-nr-${ID}`).remove({ force: true }).catch(() => {});
  await resetDataDir(ID);
  await raw.getNetwork(`${NET}-${ID}`).remove().catch(() => {});
}

async function main() {
  console.log('\n──── docker-compose 部署 · 真实验证 ────\n');
  await resetRoot();   // bind 挂载不随 down -v 消失，必须显式清

  /*
   * 必填变量缺失时必须拒绝，而不是带空值起来。
   *
   * 一次只留空一个变量、逐个验：compose 只报**它先撞上的那一个**，
   * 而遍历顺序不稳定 —— 两个都留空时约四分之一的运行会报 MASTER_KEY 而非
   * EXTERNAL_URL。断言写死其中一个名字就会随机翻绿翻红。
   */
  const refusalFor = (missing) => {
    const lines = ['EXTERNAL_URL=http://127.0.0.1:1', 'MASTER_KEY=x']
      .filter((l) => !l.startsWith(`${missing}=`));
    writeFileSync(envFile, lines.join('\n') + `\n${missing}=\n`);
    try {
      compose('config', '--quiet');
      return null;                                  // 竟然通过了校验
    } catch (e) {
      return String(e.stderr ?? e.message).trim();
    }
  };

  for (const v of ['EXTERNAL_URL', 'MASTER_KEY']) {
    const msg = refusalFor(v);
    check(`缺 ${v} 时 compose 拒绝启动并指名`,
          msg !== null && msg.includes(v),
          msg === null ? '竟然通过了校验' : msg.split('\n')[0].slice(0, 64));
  }

  writeFileSync(envFile, [
    `EXTERNAL_URL=${B}`,
    'MASTER_KEY=compose-verify-master-key',
    // 给验证构建单独的镜像名。不这么做的话，构建产物会顶掉开发机上那份
    // 从 Docker Hub 拉来的同名正式镜像 —— 之后本机 `docker compose up`
    // 跑的就是验证构建，而 `docker images` 上看不出任何异常。
    'MANAGER_IMAGE=thinglinks-edge-manager:compose-verify',
    `DOCKER_GID=${socketGid()}`,
    'BIND_ADDR=127.0.0.1',
    `HOST_PORT=${PORT}`,
    `INSTANCE_NETWORK=${NET}`,
    `ALLOWED_IMAGE_TAGS=${TAG}`,
    `EDGE_DATA_ROOT=${TEST_EDGE_ROOT}`,
    `EDGE_NAME_PREFIX=${PREFIX}`,
    'INSTANCE_PORT_MIN=31300',
    'INSTANCE_PORT_MAX=31399',
  ].join('\n') + '\n');

  await cleanup();
  console.log('  · docker compose up -d --build …');
  compose('up', '-d', '--build');

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    ready = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('compose 起栈后 Manager 就绪', ready);
  if (!ready) {
    console.log(compose('logs', '--tail', '20', 'manager').split('\n').map((l) => '      ' + l).join('\n'));
    throw new Error('compose 栈未就绪');
  }

  const info = await raw.getContainer(MGR).inspect();
  check('只读根文件系统已生效', info.HostConfig.ReadonlyRootfs === true);
  check('已禁止提权（no-new-privileges）',
        (info.HostConfig.SecurityOpt ?? []).some((o) => /no-new-privileges/.test(o)));
  // 同名挂载：容器内路径必须等于宿主路径，否则 Manager 写进实例 Binds 的路径
  // 会被宿主 daemon 解析到别处 —— 静默挂错盘
  check('数据根同名挂载（容器内路径 == 宿主路径）',
        (info.Mounts ?? []).some((m) => m.Source === TEST_EDGE_ROOT && m.Destination === TEST_EDGE_ROOT),
        (info.Mounts ?? []).map((m) => `${m.Source}→${m.Destination}`).join(' ') || '无绑定挂载');

  const { access } = await import('node:fs/promises');
  const dbPath = `${TEST_EDGE_ROOT}/manager/edge.db`;
  check('库文件落在宿主数据根上，不在容器可写层',
        await access(dbPath).then(() => true).catch(() => false), dbPath);

  // hostname 回退之所以不能依赖：compose 下 hostname 是容器短 id 而非容器名，
  // 一旦部署时显式设了 hostname:，回退拿到的就是个 Docker 不认识的名字
  check('容器 hostname 不等于容器名（故 MANAGER_CONTAINER 必须显式配置）',
        info.Config.Hostname !== MGR, `hostname=${info.Config.Hostname} vs 容器名=${MGR}`);

  /*
   * 首次设置：口令**不再出现在日志里**，由这一步现场指定。
   * 顺带把「日志里没有口令」当成一条断言 —— 那正是这次改造要保住的性质。
   */
  const logs = compose('logs', 'manager');
  check('启动日志里没有任何口令',
        !/初始口令/.test(logs) && !logs.includes(SETUP_PW),
        /\[init\]/.test(logs) ? '有 [init] 行但不含口令' : '');

  const state = await (await fetch(`${B}/api/setup`)).json();
  check('全新部署上匿名读得到「需要首次设置」', state.needed === true, JSON.stringify(state));

  const setupRes = await fetch(`${B}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
  });
  const cookie = (setupRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  check('设置完直接带着会话进去，不必再登录一次',
        setupRes.status === 200 && cookie.includes('tle_sid') && Boolean(csrf),
        `HTTP ${setupRes.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: 'compose 验证', imageTag: TAG,
                           ports: [{ hostPort: 31300, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT' }] }),
  });
  // 失败时把正文带出来 —— 光一个「HTTP 400」在这一步是排不动的
  const createdDetail = created.status === 201 ? '' : (await created.text()).slice(0, 160);
  check('创建实例成功（只读 rootfs 下 SQLite 仍可写）', created.status === 201,
        `HTTP ${created.status}${createdDetail ? ' ' + createdDetail : ''}`);

  const netInfo = await raw.getNetwork(`${NET}-${ID}`).inspect();
  const attached = Object.values(netInfo.Containers ?? {}).map((c) => c.Name);
  check('MANAGER_CONTAINER 生效：Manager 接入了实例网络', attached.includes(MGR), attached.join(' + '));

  // ── 受限 docker 代理 ────────────────────────────────────
  // 走到这里说明整条生命周期（建网络/建卷/建容器/塞 settings.js/启停/取日志/取 stats）
  // 都已经过代理跑通了 —— 这就是「白名单够用」的反证，不必再逐条正面验。
  const mounts = (info.Mounts ?? []).map((m) => m.Source);
  check('Manager 已不再挂载宿主 docker.sock',
        !mounts.some((m) => String(m).includes('docker.sock')), mounts.join(' ') || '（无绑定挂载）');
  check('Manager 已不需要附加属组',
        (info.HostConfig.GroupAdd ?? []).length === 0, JSON.stringify(info.HostConfig.GroupAdd ?? []));

  const proxyInfo = await raw.getContainer(PROXY).inspect();
  check('特权集中在代理上：只有它挂 socket，且是只读',
        (proxyInfo.Mounts ?? []).some((m) => String(m.Source).includes('docker.sock') && m.RW === false));

  const startupLog = compose('logs', 'manager');
  check('Manager 启动日志确认端点是代理而非裸 socket',
        startupLog.includes(`docker 端点 ${PROXY}:2375（受限代理）`),
        /docker 端点 (.+)$/m.exec(startupLog)?.[1]?.trim() ?? '日志里没有端点信息');

  /** 在某个容器里用 node 的 fetch 探一下代理，返回 'S<状态码>' 或 'X' */
  const probeFrom = (container, path) => {
    const js = `fetch('http://${PROXY}:2375${path}',{signal:AbortSignal.timeout(4000)})`
      + `.then(r=>console.log('S'+r.status)).catch(()=>console.log('X'))`;
    try { return sh(['exec', container, 'node', '-e', js]).trim(); } catch { return 'X'; }
  };

  check('代理放行 Manager 真正要用的端点', probeFrom(MGR, '/version') === 'S200', probeFrom(MGR, '/version'));

  /*
   * `/info` 是**刻意放行**的（dc2cc90）：安装自检的「架构与镜像匹配」
   * 「cgroup 内存限制」两项只能从这里读，缺了它们现场发现不了
   * 「内存限额配了但不生效」——那种故障界面上一切正常，实例却能吃光整机内存。
   * 它是纯只读的守护进程元信息，敏感度低于白名单里已有的 containers/json。
   */
  check('代理放行只读的 /info（安装自检的架构与 cgroup 两项靠它）',
        probeFrom(MGR, '/info') === 'S200', probeFrom(MGR, '/info'));

  const denied = ['/events', '/swarm', '/secrets', '/plugins'];
  const denyResults = denied.map((p) => `${p}=${probeFrom(MGR, p)}`);
  check('代理拒绝白名单外的端点',
        denyResults.every((r) => r.endsWith('=S403')), denyResults.join(' '));

  const execDenied = (() => {
    const js = `fetch('http://${PROXY}:2375/containers/${MGR}/exec',{method:'POST',`
      + `signal:AbortSignal.timeout(4000)}).then(r=>console.log('S'+r.status)).catch(()=>console.log('X'))`;
    try { return sh(['exec', MGR, 'node', '-e', js]).trim(); } catch { return 'X'; }
  })();
  check('代理拒绝 exec —— 拿到 Manager 也开不了容器内的壳', execDenied === 'S403', execDenied);

  // 实例各有各的网络，代理只在 edge-docker 上，实例根本够不到
  const fromInstance = probeFrom(`tle-nr-${ID}`, '/version');
  check('实例容器够不到代理（网络上就不通）', fromInstance === 'X', fromInstance);

  let editor = 0;
  for (let i = 0; i < 40 && editor !== 200; i++) {
    await sleep(1000);
    editor = await fetch(`${B}/red/${ID}/`, { headers: { cookie }, redirect: 'manual' })
      .then((r) => r.status).catch(() => 0);
  }
  check('打开编辑器可用（反代按容器名解析到实例）', editor === 200, `HTTP ${editor}`);

  await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: H });
  await sleep(500);

  compose('down', '-v');
  const gone = await raw.getContainer(MGR).inspect().then(() => false).catch(() => true);
  check('compose down -v 清理干净', gone);

  await cleanup();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  if (pass !== results.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('\n  验证异常：', e.message);
  await cleanup();
  process.exit(1);
});
