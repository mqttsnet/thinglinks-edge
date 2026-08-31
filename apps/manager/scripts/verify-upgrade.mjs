/**
 * 实例镜像版本升级验证（01 号文 5.2）—— 对着**真实容器**跑，跨两个 Node-RED 大版本。
 *
 * 这个功能的价值全在**失败路径**上，所以断言的重心也在那儿：
 *
 *   现场的设备一装就是几年，中间必然要打安全补丁。而受限 docker 代理刻意不放行
 *   `images/create`，现场也常常没有外网 —— 也就是说「升级挂了、镜像拉不回来」
 *   在这里不是小概率事件，是默认处境。因此：
 *
 *     · 新镜像不在本机 → **必须在动旧容器之前就拒绝**
 *     · 新版本起不来   → **必须自动退回旧版本并跑起来**
 *
 *   升级失败可以接受，升级失败之后实例没了不可接受。前者现场能重试，后者只能打电话。
 *
 * 数据必须原样活下来：流程、账号、adminRoot、端口。升级的定义就是
 * 「换个版本继续跑同一台实例」。
 */
import Docker from 'dockerode';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot, resetDataDir } from './_data-root.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const NET = 'tle-upg-net';
const BRIDGE = 'tle-upg-bridge';
const PORT = 13288;
const NR_PORT = 30950;
const ADMIN_PW = 'initial-password-123';
const ID = 'upg-a';

const OLD_TAG = '4.1.13-22-minimal';
const NEW_TAG = '5.0.4-24-minimal';
/** 白名单里有、但本机没有的版本 —— 用来验「先检查后动手」 */
const ABSENT_TAG = '9.9.9-absent';
/**
 * 一个**创建得了、启动不了**的镜像：把 alpine 打上 node-red 的 tag。
 * buildCreateOptions 固定 `User: node-red`，而 alpine 里没有这个用户，
 * 于是 docker create 成功、docker start 报 "unable to find user node-red"。
 * 这是真实的 docker 失败，不是注入的桩 —— 正好用来逼出回滚路径。
 */
const BROKEN_TAG = 'tle-broken-test';

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inspect = async () =>
  raw.getContainer(containerName(ID)).inspect().catch(() => null);
const imageOf = async () => {
  const i = await inspect();
  return i ? i.Config.Image : '(容器不存在)';
};
const running = async () => {
  const i = await inspect();
  return i ? i.State.Running === true : false;
};

/** 一条能认出来的流程，用来证明升级没把数据弄丢 */
const FLOWS = [
  { id: 'tab-upg', type: 'tab', label: '升级验证流' },
  { id: 'node-upg-marker', type: 'inject', z: 'tab-upg', name: 'UPGRADE-MARKER',
    props: [{ p: 'payload' }], payload: 'keep-me', payloadType: 'str', x: 150, y: 100, wires: [[]] },
];

async function cleanup() {
  await raw.getContainer(`${BRIDGE}-${ID}`).remove({ force: true }).catch(() => {});
  await raw.getContainer(containerName(ID)).remove({ force: true }).catch(() => {});
  await raw.getNetwork(`${NET}-${ID}`).remove().catch(() => {});
  await raw.getImage(`nodered/node-red:${BROKEN_TAG}`).remove().catch(() => {});
  await resetDataDir(ID);
}

let server;
async function main() {
  await cleanup();
  await ensureRoot();

  // 造出那个「起不来」的镜像：给 alpine 打上 node-red 的 tag
  await raw.getImage('alpine:3.22').tag({ repo: 'nodered/node-red', tag: BROKEN_TAG });

  const db = openDb(':memory:');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, deriveKey('verify', 'salt'));
  const users = new UserRepo(db);
  const viewerPassword = users.create('watcher', 'viewer', 'admin');

  const docker = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 },
    instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: [OLD_TAG, NEW_TAG, ABSENT_TAG, BROKEN_TAG],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
    dataDir: `${TEST_EDGE_ROOT}/manager`, dataRoot: TEST_EDGE_ROOT,
    instanceDataRoot: TEST_DATA_ROOT,
    portRange: { min: 30000, max: 30999 }, timezone: 'Asia/Shanghai', updateCheckUrl: '',
  };

  const app = buildServer({
    config, db, auth, repo, service,
    upstreamFor: () => `http://127.0.0.1:${NR_PORT}`,
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  server = app;
  const B = `http://127.0.0.1:${PORT}`;
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  const admin = await adminSession(B, ADMIN_PW);
  check('管理员登录成功', Boolean(admin.csrf));

  // ── 建一台旧版本实例并部署流程 ─────────────────
  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ id: ID, name: ID, imageTag: OLD_TAG, memoryMb: 512, cpus: 0.5, ports: [] }),
  });
  check(`建实例（${OLD_TAG}）`, created.status === 201,
    created.status === 201 ? '' : `HTTP ${created.status} ${JSON.stringify(await created.json()).slice(0, 200)}`);

  for (let i = 0; i < 40 && !(await running()); i++) await sleep(1000);
  check('实例在运行', await running(), await imageOf());

  await raw.createContainer({
    name: `${BRIDGE}-${ID}`, Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${NR_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    ExposedPorts: { [`${NR_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      PortBindings: { [`${NR_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(NR_PORT) }] },
    },
  }).then((c) => c.start());
  await sleep(1500);

  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${B}/api/instances/${ID}/flows`, { headers: { cookie: admin.cookie } })
        .catch(() => null);
      if (r && r.status === 200) return true;
      await sleep(1000);
    }
    return false;
  };
  check('Admin API 就绪', await ready());

  const deployed = await fetch(`${B}/api/instances/${ID}/flows`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ flows: FLOWS }),
  });
  check('部署一条可识别的流程', deployed.status === 200, `HTTP ${deployed.status}`);

  const flowsPresent = async () => {
    const r = await fetch(`${B}/api/instances/${ID}/flows`, { headers: { cookie: admin.cookie } })
      .catch(() => null);
    if (!r || r.status !== 200) return false;
    return JSON.stringify(await r.json()).includes('UPGRADE-MARKER');
  };
  check('流程读得回来', await flowsPresent());

  const upgrade = async (tag, s = admin) => {
    const res = await fetch(`${B}/api/instances/${ID}/image`, {
      method: 'POST', headers: H(s), body: JSON.stringify({ imageTag: tag }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // ── 1. 白名单外的版本一律拒绝 ─────────────────
  const notAllowed = await upgrade('6.6.6-nope');
  check('白名单外的版本被拒', notAllowed.status === 400 && /白名单/.test(notAllowed.body.error ?? ''),
    `HTTP ${notAllowed.status} ${notAllowed.body.error ?? ''}`);

  // ── 2. 关键安全属性：镜像不在本机时，不许动旧容器 ──
  const absent = await upgrade(ABSENT_TAG);
  check('镜像不在本机时拒绝升级', absent.status === 400 && /没有镜像/.test(absent.body.error ?? ''),
    `HTTP ${absent.status} ${(absent.body.error ?? '').slice(0, 80)}`);
  check('**被拒之后实例仍在运行**（先检查、后动手）', await running(), await imageOf());
  check('被拒之后版本没变', (await imageOf()).endsWith(OLD_TAG), await imageOf());
  check('被拒之后流程还在', await flowsPresent());

  // ── 3. 正常升级：跨大版本 4.x → 5.x ───────────
  const ok = await upgrade(NEW_TAG);
  check(`升级 ${OLD_TAG} → ${NEW_TAG}`, ok.status === 200 && ok.body.to === NEW_TAG,
    `HTTP ${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
  check('容器确实换成了新版本', (await imageOf()).endsWith(NEW_TAG), await imageOf());
  check('升级后实例在运行', await running());

  await sleep(1000);
  check('**升级后流程原样还在**（数据目录未被销毁）', await ready() && await flowsPresent());

  const listed = await fetch(`${B}/api/instances`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  check('平台侧记录的版本也更新了',
    listed.instances?.find((i) => i.id === ID)?.imageTag === NEW_TAG,
    listed.instances?.find((i) => i.id === ID)?.imageTag);

  // ── 4. 同版本无需升级 ─────────────────────────
  const same = await upgrade(NEW_TAG);
  check('升到同一版本被拒（不做无意义的重建）',
    same.status === 400 && /已经是/.test(same.body.error ?? ''),
    `HTTP ${same.status} ${same.body.error ?? ''}`);

  // ── 5. 关键安全属性：新版本起不来时自动回滚 ────
  const broken = await upgrade(BROKEN_TAG);
  check('坏镜像升级失败并如实报错',
    broken.status === 400 && /已回滚/.test(broken.body.error ?? ''),
    `HTTP ${broken.status} ${(broken.body.error ?? '').slice(0, 120)}`);
  check('**回滚后实例仍在运行**', await running(), await imageOf());
  check('回滚后版本退回升级前的那个', (await imageOf()).endsWith(NEW_TAG), await imageOf());
  await sleep(1000);
  check('**回滚后流程仍然完好**', await ready() && await flowsPresent());

  // ── 6. 权限 ──────────────────────────────────
  const viewer = await sessionFor(B, 'watcher', viewerPassword);
  const byViewer = await upgrade(NEW_TAG, viewer);
  check('只读用户升级不了', byViewer.status === 403, `HTTP ${byViewer.status}`);

  const noCsrf = await fetch(`${B}/api/instances/${ID}/image`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ imageTag: OLD_TAG }),
  });
  check('升级要过 CSRF', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  const anon = await fetch(`${B}/api/instances/${ID}/image`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageTag: OLD_TAG }),
  });
  check('未登录升级不了', anon.status === 401, `HTTP ${anon.status}`);
}

main()
  .catch((e) => { console.error('\n验证脚本自身出错：', e); results.push({ name: '脚本执行', ok: false }); })
  .finally(async () => {
    await server?.close().catch(() => {});
    await cleanup();
    const bad = results.filter((r) => !r.ok);
    console.log(`\n实例版本升级验证：${results.length - bad.length}/${results.length} 通过`);
    if (bad.length > 0) {
      console.log('未通过：');
      for (const r of bad) console.log(`  ✗ ${r.name}`);
    }
    process.exit(bad.length === 0 ? 0 : 1);
  });
