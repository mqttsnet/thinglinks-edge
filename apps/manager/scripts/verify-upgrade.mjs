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
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import {
  createFixtureIdentity,
  createRealInstanceFixture,
} from './_real-instance-fixture.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const identity = createFixtureIdentity({ suite: 'upg', roles: ['main'] });
const ID = identity.instances.main;

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
const BROKEN_TAG = `tle-broken-${identity.invocation}`;

let fixture;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inspect = async () =>
  fixture.raw.getContainer(containerName(ID)).inspect().catch(() => null);
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

async function main() {
  fixture = await createRealInstanceFixture({
    identity,
    allowedImageTags: [OLD_TAG, NEW_TAG, ABSENT_TAG, BROKEN_TAG],
  });
  const { db, repo } = fixture;
  const users = new UserRepo(db);
  const viewerPassword = users.create('watcher', 'viewer', 'admin');

  // 造出那个「起不来」的镜像；随机 tag 由 fixture 按不可变 image ID 回收。
  await fixture.createImageAlias('alpine:3.22', 'nodered/node-red', BROKEN_TAG);

  const B = fixture.baseUrl;
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  const admin = await adminSession(B, fixture.adminPassword, fixture.adminNextPassword);
  check('管理员登录成功', Boolean(admin.csrf));

  // ── 建模一台升级功能上线前已经存在的 legacy 旧实例 ──
  // 新实例只允许 5.x npm bootstrap；4.1 起点必须走受控 legacy fixture，
  // 否则是在要求一个声明仅支持 Node-RED >=5.0.4 的平台包装进 4.1。
  const mappedPort = await fixture.allocateMappedPort();
  await fixture.createLegacyInstance('main', {
    name: ID,
    imageTag: OLD_TAG,
    memoryMb: 512,
    cpus: 0.5,
    ports: [{
      hostPort: mappedPort,
      containerPort: 1883,
      protocol: 'tcp',
      hostIp: '127.0.0.1',
      purpose: '升级验证保留项',
    }],
  });
  check(`受控构造 legacy 实例（${OLD_TAG}）`, true);

  const originalIdentity = {
    adminRoot: repo.get(ID)?.adminRoot,
    credentials: repo.credentials(ID),
    ingestToken: repo.ingestToken(ID),
    ports: repo.ports(ID),
  };

  for (let i = 0; i < 40 && !(await running()); i++) await sleep(1000);
  check('实例在运行', await running(), await imageOf());

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
    try {
      const res = await fetch(`${B}/api/instances/${ID}/image`, {
        method: 'POST', headers: H(s), body: JSON.stringify({ imageTag: tag }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      // 成功升级与失败回滚都会替换容器；清理只能使用这里重新捕获的 immutable ID。
      await fixture.captureCurrentInstance('main');
    }
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
  check('升级只换镜像，账号/adminRoot/接入令牌/端口全部保留',
    JSON.stringify({
      adminRoot: repo.get(ID)?.adminRoot,
      credentials: repo.credentials(ID),
      ingestToken: repo.ingestToken(ID),
      ports: repo.ports(ID),
    }) === JSON.stringify(originalIdentity));

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
  check('失败回滚仍保留账号/adminRoot/接入令牌/端口',
    JSON.stringify({
      adminRoot: repo.get(ID)?.adminRoot,
      credentials: repo.credentials(ID),
      ingestToken: repo.ingestToken(ID),
      ports: repo.ports(ID),
    }) === JSON.stringify(originalIdentity));

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
    const cleanupFailures = fixture ? await fixture.cleanup() : [];
    if (cleanupFailures.length > 0) {
      console.error('\n验证资源清理失败：', cleanupFailures.join(' | '));
      results.push({ name: '随机验证资源清理', ok: false });
    }
    const bad = results.filter((r) => !r.ok);
    console.log(`\n实例版本升级验证：${results.length - bad.length}/${results.length} 通过`);
    if (bad.length > 0) {
      console.log('未通过：');
      for (const r of bad) console.log(`  ✗ ${r.name}`);
    }
    process.exitCode = bad.length === 0 ? 0 : 1;
  });
