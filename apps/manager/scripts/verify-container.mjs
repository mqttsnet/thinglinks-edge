/**
 * Manager 容器化验证 —— 把 Manager 本身跑成容器，验证宿主态跑不通的那两条链路。
 *
 * 开发态 Manager 跑在宿主上时，`tle-nr-{id}:1880` 这个容器名解析不了，
 * 因此**应用层探针**与**打开编辑器（反代）**都不通。这不是缺陷，是拓扑决定的。
 * 本脚本把 Manager 放进容器、让它按 managerContainer 接入每个实例网络，
 * 从外部证明这两条链路在生产拓扑下确实可用。
 *
 * 同时验证网络回收：Manager 接入实例网络后，删实例前必须先把自己摘出去，
 * 否则 Docker 拒删网络 —— 而那个失败是被吞掉的，只会攒下一堆空网络。
 */
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authTokenKeyFor } from '../dist/core/config.js';
import { TEST_EDGE_ROOT, TEST_DATA_ROOT, ensureRoot, resetRoot, resetDataDir } from './_data-root.mjs';
import { adminSession } from './_session.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IMAGE = 'thinglinks-edge-manager:verify';
const MGR = 'tle-mgr-verify';
const NET = 'tle-verify-net';
const PORT = 13210;
const ADMIN_PW = 'initial-password-123';
const ID = 'ctr-a';
const TAG = '5.0.4-24-minimal';
/** 第一个参数是挂载前缀，用于覆盖「企业反代把服务挂在子路径下」的形态 */
const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const B = `${ORIGIN}${BASE}`;

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

const networkName = (id) => `${NET}-${id}`;
const netExists = async (name) => raw.getNetwork(name).inspect().then(() => true).catch(() => false);

/** docker.sock 在容器内的属组因宿主而异（Docker Desktop 下是 0，多数 Linux 是 docker 组） */
function socketGid() {
  return sh('docker', ['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock',
    'alpine', 'stat', '-c', '%g', '/var/run/docker.sock']).trim();
}

async function cleanup() {
  await raw.getContainer(MGR).remove({ force: true }).catch(() => {});
  await raw.getContainer(`tle-nr-${ID}`).remove({ force: true }).catch(() => {});
  await resetDataDir(ID);
  await raw.getNetwork(networkName(ID)).remove().catch(() => {});
}

async function main() {
  console.log(`\n──── Manager 容器化 · 真实 Docker 验证（前缀 ${BASE || '/'}）────\n`);
  await resetRoot();   // bind 挂载不随 down -v 消失，必须显式清
  await cleanup();

  console.log('  · 构建镜像…');
  sh('docker', ['build', '-f', 'apps/manager/Dockerfile', '-t', IMAGE, '.'], { cwd: REPO, stdio: 'pipe' });

  const gid = socketGid();
  console.log(`  · 启动 Manager 容器（docker.sock 属组 gid=${gid}）…`);
  sh('docker', [
    'run', '-d', '--name', MGR,
    '--group-add', gid,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    // 同名挂载：容器内路径必须等于宿主路径。Manager 用容器内视角 mkdir 实例数据目录，
    // 而 daemon 用宿主视角解析实例的 Binds —— 不同名就会各写各的，且毫无症状。
    '-v', `${TEST_EDGE_ROOT}:${TEST_EDGE_ROOT}`,
    '-p', `127.0.0.1:${PORT}:19100`,
    '-e', `EDGE_DATA_ROOT=${TEST_EDGE_ROOT}`,
    '-e', `EXTERNAL_URL=${B}`,
    '-e', 'MASTER_KEY=verify-master-key',
    '-e', `INITIAL_PASSWORD=${ADMIN_PW}`,
    '-e', `INSTANCE_NETWORK=${NET}`,
    '-e', `ALLOWED_IMAGE_TAGS=${TAG}`,
    // 故意不给 MANAGER_CONTAINER：走 /.dockerenv + hostname 的回退分支
    IMAGE,
  ]);

  // 就绪等待
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(500);
    ready = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('Manager 以非 root 在容器内启动并就绪', ready);
  if (!ready) {
    console.log(sh('docker', ['logs', MGR]).split('\n').slice(-15).map((l) => '      ' + l).join('\n'));
    throw new Error('Manager 容器未就绪');
  }

  /*
   * 库文件必须真的落在宿主 bind 挂载上。
   * 镜像里一旦钉死 DATA_DIR，它会覆盖由 EDGE_DATA_ROOT 派生的默认值 ——
   * 只读根文件系统下表现为启动失败，可写根文件系统下更阴：悄悄落进容器可写层，
   * 功能全正常、测试全绿，容器一删数据就没了。所以这条要从**宿主侧**看。
   */
  const { access } = await import('node:fs/promises');
  const dbPath = `${TEST_EDGE_ROOT}/manager/edge.db`;
  const dbOnHost = await access(dbPath).then(() => true).catch(() => false);
  check('库文件落在宿主数据根上，不在容器可写层', dbOnHost, dbPath);

  const whoami = sh('docker', ['exec', MGR, 'id', '-un']).trim();
  check('容器内进程不是 root', whoami === 'node', `user=${whoami}`);

  // 登录
  const sess = await adminSession(B, ADMIN_PW);
  const { cookie, csrf } = sess;
  const login = { status: sess.status };
  check('登录成功', login.status === 200 && Boolean(csrf), `HTTP ${login.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // 创建实例
  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    // 两条不连号映射，且第二条绑到全部网卡 —— 现场设备要连的就是这种
    body: JSON.stringify({ id: ID, name: '容器化验证', imageTag: TAG,
                           ports: [
                             { hostPort: 30200, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT broker' },
                             { hostPort: 30201, containerPort: 502, protocol: 'tcp', hostIp: '0.0.0.0', purpose: 'Modbus TCP' },
                           ] }),
  });
  check('通过容器内 Manager 创建实例', created.status === 201, `HTTP ${created.status}`);

  // 端口字段名写错会被服务端静默忽略，只断言 201 是看不出来的
  const createdPorts = created.status === 201 ? (await created.json()).instance.ports : [];
  check('端口映射逐条落到宿主，容器端口不被改写', createdPorts.length === 2
          && createdPorts.some((p) => p.hostPort === 30200 && p.containerPort === 1883)
          && createdPorts.some((p) => p.hostPort === 30201 && p.containerPort === 502),
        createdPorts.map((p) => `${p.hostPort}→${p.containerPort}`).join(' ') || '一个都没有');

  // 这条是本次修复的要害：早先 hostIp 前端从不发送，永远绑 127.0.0.1，
  // 于是现场设备根本连不上，而界面上一切正常
  const nrInfo = await raw.getContainer(`tle-nr-${ID}`).inspect();
  const bindings = nrInfo.HostConfig.PortBindings ?? {};
  check('指定的监听网卡真的传到了 Docker',
        bindings['1883/tcp']?.[0]?.HostIp === '127.0.0.1'
          && bindings['502/tcp']?.[0]?.HostIp === '0.0.0.0',
        JSON.stringify(bindings));

  // 时区：官方镜像默认 UTC，不注入 TZ 的话定时流程与时间戳整体偏移且不报错
  const tzOut = (await raw.getContainer(`tle-nr-${ID}`).inspect()).Config.Env
    .find((e) => e.startsWith('TZ='));
  check('实例容器注入了时区，不再跑在 UTC 上', tzOut === 'TZ=Asia/Shanghai', String(tzOut));

  // Manager 是否真的接入了实例网络
  const netInfo = await raw.getNetwork(networkName(ID)).inspect();
  const attached = Object.values(netInfo.Containers ?? {}).map((c) => c.Name);
  check('Manager 已接入实例网络（一实例一网络仍成立）',
        attached.includes(MGR) && attached.includes(`tle-nr-${ID}`),
        attached.join(' + '));

  // ── A3 的两条核心验收 ──
  let health = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    health = await fetch(`${B}/api/instances/${ID}/health`, { headers: { cookie } })
      .then((r) => r.json()).then((b) => b.health).catch(() => null);
    if (health?.app?.ok) break;
  }
  check('应用层探针在容器内跑通（宿主态解析不了容器名）',
        health?.app?.ok === true, `app=${JSON.stringify(health?.app ?? null).slice(0, 60)}`);
  check('三层探针综合判定健康', health?.verdict === 'healthy', `verdict=${health?.verdict}`);

  const editor = await fetch(`${B}/red/${ID}/`, { headers: { cookie }, redirect: 'manual' });
  const editorBody = editor.status === 200 ? await editor.text() : '';
  check('打开编辑器：反代取回真实 Node-RED 页面',
        editor.status === 200 && /node-red/i.test(editorBody), `HTTP ${editor.status}`);

  const sso = await fetch(`${B}/red/${ID}/sso`, { headers: { cookie } });
  const ssoBody = sso.status === 200 ? await sso.text() : '';
  const expectedKey = authTokenKeyFor(`${BASE}/red/${ID}/`);
  check('免密跳转下发按 httpAdminRoot 命名空间化的 token 键',
        sso.status === 200 && ssoBody.includes(expectedKey),
        /setItem\("([^"]+)"/.exec(ssoBody)?.[1] ?? `HTTP ${sso.status}`);

  const logs = await (await fetch(`${B}/api/instances/${ID}/logs?tail=40`, { headers: { cookie } })).text();
  check('日志已解帧（容器内同样走多路复用流）',
        logs.includes('Server now running at') && ![...logs].some((c) => c.codePointAt(0) < 0x09));

  // ── @thinglinks 节点集 ──
  /*
   * 节点集由 Manager 拷进实例数据目录，靠 settings.js 的 nodesDir 扫目录加载。
   * 光断言「文件拷过去了」不够 —— 文件在而 Node-RED 没扫到是完全可能的，
   * 表现是面板里没有 ThingLinks 分类，**没有任何报错**。
   * 所以要看 Node-RED 自己写出的 .config.nodes.json。
   */
  const { readFile } = await import('node:fs/promises');
  const nodesManifest = `${TEST_DATA_ROOT}/${ID}/.config.nodes.json`;
  let manifest = null;
  for (let i = 0; i < 40 && manifest === null; i++) {
    await sleep(500);
    manifest = await readFile(nodesManifest, 'utf8').then(JSON.parse).catch(() => null);
  }
  const registered = manifest
    ? Object.values(manifest).flatMap((m) => Object.entries(m.nodes ?? {}))
        .filter(([name]) => name.startsWith('tl-'))
    : [];
  check('Node-RED 真的加载了 @thinglinks 三个节点',
        registered.length === 3 && registered.every(([, n]) => !n.err),
        registered.map(([name, n]) => `${name}${n.err ? '(err)' : ''}`).join(' ') || '一个都没有');

  const instEnv = (await raw.getContainer(`tle-nr-${ID}`).inspect()).Config.Env ?? [];
  check('实例注入了接入令牌与管理台地址',
        instEnv.some((e) => e.startsWith('TLE_INGEST_TOKEN=') && e.length > 20) &&
        instEnv.some((e) => e.startsWith('TLE_MANAGER_URL=http://')),
        instEnv.filter((e) => e.startsWith('TLE_')).map((e) => e.split('=')[0]).join(' '));

  // ── 控制台静态托管 ──
  const home = await fetch(`${B}/`);
  const homeHtml = home.status === 200 ? await home.text() : '';
  check('控制台首页由 Manager 托管', home.status === 200 && homeHtml.includes('id="app"'), `HTTP ${home.status}`);
  check('首页注入了运行期挂载前缀',
        homeHtml.includes(`<base href="${BASE}/">`) && homeHtml.includes(`__TLE_BASE__=${JSON.stringify(BASE)}`),
        /<base href="([^"]*)"/.exec(homeHtml)?.[1] ?? '未注入');

  // 相对路径资源必须按注入的 <base> 解析得到，这正是子路径形态最容易翻车的地方
  const assetRef = /src="(\.\/assets\/[^"]+\.js)"/.exec(homeHtml)?.[1];
  const assetUrl = assetRef ? `${B}/${assetRef.replace(/^\.\//, '')}` : '';
  const asset = assetUrl ? await fetch(assetUrl) : null;
  check('相对路径资源按 <base> 解析后可取回',
        asset?.status === 200 && (asset.headers.get('content-type') ?? '').includes('javascript'),
        assetRef ?? '首页未引用资源');
  check('带哈希的资源标记为长缓存不可变',
        (asset?.headers.get('cache-control') ?? '').includes('immutable'),
        asset?.headers.get('cache-control') ?? '');

  const deep = await fetch(`${B}/instances`);
  check('深链接由 SPA 兜底返回首页', deep.status === 200 && (await deep.text()).includes('id="app"'), `HTTP ${deep.status}`);

  const unknownApi = await fetch(`${B}/api/definitely-not-a-route`, { headers: { cookie } });
  const unknownType = unknownApi.headers.get('content-type') ?? '';
  check('未知 API 路径仍返回 JSON 404，不被 SPA 兜底吞掉',
        unknownApi.status === 404 && unknownType.includes('application/json'),
        `HTTP ${unknownApi.status} ${unknownType.split(';')[0]}`);

  const stillProxied = await fetch(`${B}/red/${ID}/`, { headers: { cookie }, redirect: 'manual' });
  const stillHtml = stillProxied.status === 200 ? await stillProxied.text() : '';
  check('反代未被 SPA 兜底吞掉（仍是 Node-RED 而非控制台）',
        stillProxied.status === 200 && !stillHtml.includes('__TLE_BASE__'), `HTTP ${stillProxied.status}`);

  if (BASE) {
    const outside = await fetch(`${ORIGIN}/instances`);
    check('挂载前缀之外的路径不串台（404 而非控制台）', outside.status === 404, `HTTP ${outside.status}`);
  }

  // ── 备份与异机恢复演练（T4.3）──
  /*
   * 真正的验收是「**异机**恢复」：把备份搬到一台什么都没有的机器上，
   * 恢复完能不能把实例带回来。这里用「全新数据根 + 全新 Manager 容器」模拟另一台机器。
   */
  const bkRes = await fetch(`${B}/api/backup`, { method: 'POST', headers: H });
  const bkBuf = Buffer.from(await bkRes.arrayBuffer());
  check('备份可下载且是 tar', bkRes.status === 200 &&
        (bkRes.headers.get('content-type') ?? '').includes('x-tar') && bkBuf.length > 1024,
        `${bkBuf.length} 字节`);

  const { readManifest } = await import('../dist/core/archive/backup.js');
  const bkManifest = readManifest(bkBuf);
  check('备份清单含实例与 MASTER_KEY 指纹',
        bkManifest.instances.some((i) => i.id === ID) &&
        typeof bkManifest.masterKeyFingerprint === 'string' &&
        bkManifest.masterKeyFingerprint.length === 16,
        `${bkManifest.instances.length} 个实例 · 指纹 ${bkManifest.masterKeyFingerprint}`);

  // 「另一台机器」：全新数据根，把备份文件放进去
  const { mkdtemp, writeFile: wf, mkdir: mkd } = await import('node:fs/promises');
  const otherRoot = await mkdtemp('/private/tmp/tle-restore-');
  await mkd(`${otherRoot}/manager`, { recursive: true, mode: 0o777 });
  await mkd(`${otherRoot}/instances`, { recursive: true, mode: 0o777 });
  await wf(`${otherRoot}/backup.tar`, bkBuf);
  sh('docker', ['run', '--rm', '-v', `${otherRoot}:${otherRoot}`,
      '-e', `EXTERNAL_URL=${B}`, '-e', 'MASTER_KEY=verify-master-key',
      '-e', `EDGE_DATA_ROOT=${otherRoot}`,
      IMAGE, 'node', 'dist/index.js', 'restore', `${otherRoot}/backup.tar`]);

  const { openDb } = await import('../dist/core/db.js');
  const { deriveKey } = await import('../dist/core/auth/crypto.js');
  const { InstanceRepo } = await import('../dist/core/instance/repo.js');
  const restoredDb = openDb(`${otherRoot}/manager/edge.db`);
  const restoredRepo = new InstanceRepo(restoredDb, deriveKey('verify-master-key', 'thinglinks-edge:instance-cred'));
  check('异机恢复后实例记录回来了',
        restoredRepo.get(ID) !== undefined, restoredRepo.list().map((i) => i.id).join(' '));
  check('异机恢复后实例凭据仍能解开（MASTER_KEY 一致）',
        (restoredRepo.credentials(ID)[0]?.password ?? '').length >= 20,
        restoredRepo.credentials(ID)[0] ? '可解密' : '解不开');
  restoredDb.close();

  const fsp = await import('node:fs/promises');
  check('实例的流程文件也跟着回来',
        await fsp.access(`${otherRoot}/instances/${ID}/settings.js`).then(() => true).catch(() => false));

  // 密钥不对时必须当场失败，而不是恢复出「能启动但实例全起不来」的系统
  let keyRefused = false;
  try {
    sh('docker', ['run', '--rm', '-v', `${otherRoot}:${otherRoot}`,
        '-e', `EXTERNAL_URL=${B}`, '-e', 'MASTER_KEY=a-totally-different-key',
        '-e', `EDGE_DATA_ROOT=${otherRoot}`,
        IMAGE, 'node', 'dist/index.js', 'restore', `${otherRoot}/backup.tar`], { stdio: 'pipe' });
  } catch (e) {
    keyRefused = /MASTER_KEY 与备份不符/.test(String(e.stderr ?? e.stdout ?? e.message));
  }
  check('MASTER_KEY 不符时拒绝恢复并说清原因', keyRefused);
  await import('node:fs/promises').then((m) => m.rm(otherRoot, { recursive: true, force: true }));

  // ── 网络回收 ──
  const del = await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: H });
  check('删除实例返回成功', del.status < 300, `HTTP ${del.status}`);
  await sleep(500);
  check('实例网络已回收（Manager 先摘出自己才删得掉）', !(await netExists(networkName(ID))));

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
