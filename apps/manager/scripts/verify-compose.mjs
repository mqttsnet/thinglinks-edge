/**
 * docker-compose 部署验证 —— 只验 compose 这一层特有的风险，
 * 实例生命周期与反代已由 verify-container.mjs 覆盖，不重复。
 *
 * compose 特有的坑：
 *   · 必填变量缺失时应当**拒绝启动**，而不是带着空值跑起来
 *   · 容器 hostname 不是容器名，MANAGER_CONTAINER 若依赖回退，
 *     换个编排方式就会接入失败 —— 表现是反代 502、健康页应用层不通，
 *     而 Manager 本身「看起来正常」
 *   · read_only 根文件系统开启后进程仍须能正常读写数据卷
 */
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'tle-compose-verify';
const MGR = 'thinglinks-edge-manager';
const NET = 'tle-cv-net';
const PORT = 13211;
const ADMIN_PW = 'initial-password-123';
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
const compose = (...args) => sh(['compose', '-p', PROJECT, '--env-file', envFile, ...args], { stdio: 'pipe' });

function socketGid() {
  return sh(['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    'alpine', 'stat', '-c', '%g', '/var/run/docker.sock']).trim();
}

async function cleanup() {
  try { compose('down', '-v', '--remove-orphans'); } catch { /* 未起过 */ }
  await raw.getContainer(`tle-nr-${ID}`).remove({ force: true }).catch(() => {});
  await raw.getVolume(`tle-nr-${ID}-data`).remove({ force: true }).catch(() => {});
  await raw.getNetwork(`${NET}-${ID}`).remove().catch(() => {});
}

async function main() {
  console.log('\n──── docker-compose 部署 · 真实验证 ────\n');

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
    `DOCKER_GID=${socketGid()}`,
    'BIND_ADDR=127.0.0.1',
    `HOST_PORT=${PORT}`,
    `INSTANCE_NETWORK=${NET}`,
    `ALLOWED_IMAGE_TAGS=${TAG}`,
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
  check('数据卷挂载在 /data', (info.Mounts ?? []).some((m) => m.Destination === '/data'));

  // hostname 回退之所以不能依赖：compose 下 hostname 是容器短 id 而非容器名，
  // 一旦部署时显式设了 hostname:，回退拿到的就是个 Docker 不认识的名字
  check('容器 hostname 不等于容器名（故 MANAGER_CONTAINER 必须显式配置）',
        info.Config.Hostname !== MGR, `hostname=${info.Config.Hostname} vs 容器名=${MGR}`);

  const initialPw = /初始口令：(\S+)/.exec(compose('logs', 'manager'))?.[1];
  check('首次启动打印一次初始口令', Boolean(initialPw));

  const login = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: initialPw ?? ADMIN_PW }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1];
  check('用打印的初始口令能登录', login.status === 200 && Boolean(csrf), `HTTP ${login.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: 'compose 验证', imageTag: TAG, hostPortStart: 31300, hostPortCount: 1 }),
  });
  check('创建实例成功（只读 rootfs 下 SQLite 仍可写）', created.status === 201, `HTTP ${created.status}`);

  const netInfo = await raw.getNetwork(`${NET}-${ID}`).inspect();
  const attached = Object.values(netInfo.Containers ?? {}).map((c) => c.Name);
  check('MANAGER_CONTAINER 生效：Manager 接入了实例网络', attached.includes(MGR), attached.join(' + '));

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
