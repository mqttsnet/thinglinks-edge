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
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';
import Docker from 'dockerode';
import { authTokenKeyFor } from '../dist/core/config.js';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from '../dist/core/nodes/platform-contract.js';
import { adminSession } from './_session.mjs';

const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 12);
const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-role';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const REVIEWED_MANAGER_IMAGE = process.env.MANAGER_IMAGE?.trim() ?? '';
const MGR = `tle-cmgr-${RUN_ID}`;
const NET = `tle-cnet-${RUN_ID}`;
const ID = `ctr${RUN_ID}`;
const INSTANCE_NETWORK = `${NET}-${ID}`;
const GID_HELPER = `tle-cgid-${RUN_ID}`;
const RESTORE_OK = `tle-crestore-${RUN_ID}`;
const RESTORE_BAD = `tle-cbadrestore-${RUN_ID}`;
const ADMIN_PW = `Aa1!${randomBytes(20).toString('base64url')}`;
const ADMIN_NEXT_PW = `Aa1!${randomBytes(20).toString('base64url')}`;
const MASTER_KEY = randomBytes(48).toString('base64url');
const WRONG_MASTER_KEY = randomBytes(48).toString('base64url');
const TAG = '5.0.4-24-minimal';
/** 第一个参数是挂载前缀，用于覆盖「企业反代把服务挂在子路径下」的形态 */
const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
assert.match(BASE, /^(?:\/[A-Za-z0-9._~-]+)*$/);
const CANONICAL_TMP_PARENT = realpathSync(existsSync('/private/tmp') ? '/private/tmp' : '/tmp');
assert.ok(CANONICAL_TMP_PARENT === '/private/tmp' || CANONICAL_TMP_PARENT === '/tmp');

let IMAGE;
let PORT;
let INSTANCE_PORT_A;
let INSTANCE_PORT_B;
let ORIGIN;
let B;
let RUN_ROOT;
let OWNER_FILE;
let TEST_EDGE_ROOT;
let TEST_DATA_ROOT;
let protectedBefore;

const raw = new Docker();
const results = [];
const immutableContainerIds = new Map();
const immutableNetworkIds = new Map();
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) throw new Error(`前置条件失败：${name}${detail ? `（${detail}）` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

/** docker.sock 在容器内的属组因宿主而异（Docker Desktop 下是 0，多数 Linux 是 docker 组） */
async function socketGid() {
  const gid = sh('docker', [
    'run', '--name', GID_HELPER,
    '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${INSTANCE_LABEL}=${ID}`,
    '--label', `${ROLE_LABEL}=socket-gid`, '--user', '0:0', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
    IMAGE, 'stat', '-c', '%g', '/var/run/docker.sock',
  ]).trim();
  await captureContainer(GID_HELPER, directLabels('socket-gid'));
  await removeExactContainer(GID_HELPER, (info) => {
    assert.ok(hasLabels(info.Config?.Labels, directLabels('socket-gid')));
  });
  assert.match(gid, /^\d+$/);
  return gid;
}

const isDockerNotFound = (error) => error?.statusCode === 404;
const isFsNotFound = (error) => error?.code === 'ENOENT';
const hasLabels = (actual, expected) => Object.entries(expected)
  .every(([key, value]) => actual?.[key] === value);
const directLabels = (role) => ({
  [RUN_LABEL]: RUN_ID, [INSTANCE_LABEL]: ID, [ROLE_LABEL]: role,
});

async function inspectOrAbsent(resource) {
  try {
    return await resource.inspect();
  } catch (error) {
    if (isDockerNotFound(error)) return undefined;
    throw error;
  }
}

async function requireDockerAbsent(resource, label) {
  assert.equal(await inspectOrAbsent(resource), undefined, `${label} still exists`);
}

async function requirePathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isFsNotFound(error)) return;
    throw error;
  }
  throw new Error(`${label} still exists`);
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function protectedSnapshot() {
  const snapshots = [];
  for (const name of ['thinglinks-edge-manager', 'tle-nr-line-1']) {
    const info = await inspectOrAbsent(raw.getContainer(name));
    if (!info) continue;
    snapshots.push({
      id: info.Id, name: info.Name, image: info.Image,
      state: info.State?.Status, health: info.State?.Health?.Status ?? 'none',
      startedAt: info.State?.StartedAt, restartCount: info.RestartCount,
      networks: Object.values(info.NetworkSettings?.Networks ?? {})
        .map((network) => network.NetworkID).sort(),
    });
  }
  return snapshots;
}

async function createRunRoot() {
  RUN_ROOT = await realpath(await mkdtemp(join(CANONICAL_TMP_PARENT, `tle-container-${RUN_ID}-`)));
  assert.equal(dirname(RUN_ROOT), CANONICAL_TMP_PARENT);
  assert.ok(basename(RUN_ROOT).startsWith(`tle-container-${RUN_ID}-`));
  OWNER_FILE = join(RUN_ROOT, '.verifier-owner');
  TEST_EDGE_ROOT = join(RUN_ROOT, 'edge-data');
  TEST_DATA_ROOT = join(TEST_EDGE_ROOT, 'instances');
  await writeFile(OWNER_FILE, RUN_ID, { flag: 'wx', mode: 0o600 });
  await mkdir(join(TEST_EDGE_ROOT, 'manager'), { recursive: true, mode: 0o777 });
  await mkdir(TEST_DATA_ROOT, { recursive: true, mode: 0o777 });
  await chmod(TEST_EDGE_ROOT, 0o777);
  await chmod(join(TEST_EDGE_ROOT, 'manager'), 0o777);
  await chmod(TEST_DATA_ROOT, 0o777);
}

async function removeRunRoot() {
  if (!RUN_ROOT) return;
  let stat;
  try {
    stat = await lstat(RUN_ROOT);
  } catch (error) {
    if (!isFsNotFound(error)) throw error;
    RUN_ROOT = undefined;
    return;
  }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(RUN_ROOT), RUN_ROOT);
  assert.equal(dirname(RUN_ROOT), CANONICAL_TMP_PARENT);
  assert.ok(basename(RUN_ROOT).startsWith(`tle-container-${RUN_ID}-`));
  const ownerStat = await lstat(OWNER_FILE);
  assert.ok(ownerStat.isFile() && !ownerStat.isSymbolicLink());
  assert.equal(await readFile(OWNER_FILE, 'utf8'), RUN_ID);
  await rm(RUN_ROOT, { recursive: true, force: false });
  await requirePathAbsent(RUN_ROOT, 'container verifier root');
  RUN_ROOT = undefined;
}

async function resolveManagerImage() {
  if (!REVIEWED_MANAGER_IMAGE) {
    throw new Error('verify-container requires explicit MANAGER_IMAGE');
  }
  const info = await inspectOrAbsent(raw.getImage(REVIEWED_MANAGER_IMAGE));
  if (!info) throw new Error(`MANAGER_IMAGE is not present: ${REVIEWED_MANAGER_IMAGE}`);
  assert.match(info.Id, /^sha256:[a-f0-9]{64}$/);
  return info.Id;
}

async function captureContainer(name, expectedLabels) {
  const info = await inspectOrAbsent(raw.getContainer(name));
  assert.ok(info && info.Name === `/${name}` && hasLabels(info.Config?.Labels, expectedLabels));
  const recorded = immutableContainerIds.get(name);
  if (recorded) assert.equal(info.Id, recorded, `container id changed for ${name}`);
  immutableContainerIds.set(name, info.Id);
  return info;
}

async function captureNetwork(name, expectedLabels) {
  const info = await inspectOrAbsent(raw.getNetwork(name));
  assert.ok(info && info.Name === name && hasLabels(info.Labels, expectedLabels));
  const recorded = immutableNetworkIds.get(name);
  if (recorded) assert.equal(info.Id, recorded, `network id changed for ${name}`);
  immutableNetworkIds.set(name, info.Id);
  return info;
}

async function removeExactContainer(name, verifyOwnership) {
  const expectedId = immutableContainerIds.get(name);
  const info = await inspectOrAbsent(raw.getContainer(expectedId ?? name));
  if (!info) {
    if (expectedId) {
      assert.equal(await inspectOrAbsent(raw.getContainer(name)), undefined,
        `recorded container ${expectedId} disappeared but ${name} was replaced`);
    }
    immutableContainerIds.delete(name);
    return;
  }
  if (expectedId) assert.equal(info.Id, expectedId);
  assert.equal(info.Name, `/${name}`);
  verifyOwnership(info);
  const exact = await raw.getContainer(info.Id).inspect();
  verifyOwnership(exact);
  await raw.getContainer(info.Id).remove({ force: true });
  await requireDockerAbsent(raw.getContainer(info.Id), `container ${info.Id}`);
  await requireDockerAbsent(raw.getContainer(name), `container name ${name}`);
  immutableContainerIds.delete(name);
}

async function removeExactNetwork(name, verifyOwnership) {
  const expectedId = immutableNetworkIds.get(name);
  const info = await inspectOrAbsent(raw.getNetwork(expectedId ?? name));
  if (!info) {
    if (expectedId) {
      assert.equal(await inspectOrAbsent(raw.getNetwork(name)), undefined,
        `recorded network ${expectedId} disappeared but ${name} was replaced`);
    }
    immutableNetworkIds.delete(name);
    return;
  }
  if (expectedId) assert.equal(info.Id, expectedId);
  assert.equal(info.Name, name);
  verifyOwnership(info);
  const exact = await raw.getNetwork(info.Id).inspect();
  verifyOwnership(exact);
  await raw.getNetwork(info.Id).remove();
  await requireDockerAbsent(raw.getNetwork(info.Id), `network ${info.Id}`);
  await requireDockerAbsent(raw.getNetwork(name), `network name ${name}`);
  immutableNetworkIds.delete(name);
}

async function listDirectContainers() {
  return raw.listContainers({
    all: true, filters: { label: [`${RUN_LABEL}=${RUN_ID}`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function listManagedContainers() {
  return raw.listContainers({
    all: true, filters: { label: [`${MANAGED_LABEL}=true`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function listDirectNetworks() {
  return raw.listNetworks({
    filters: { label: [`${RUN_LABEL}=${RUN_ID}`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function listManagedNetworks() {
  return raw.listNetworks({
    filters: { label: [`${MANAGED_LABEL}=true`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function cleanupScope(items, kind, verifyOwnership) {
  const errors = [];
  for (const item of items) {
    try {
      const resource = kind === 'container' ? raw.getContainer(item.Id) : raw.getNetwork(item.Id);
      const info = await inspectOrAbsent(resource);
      if (!info) continue;
      const name = kind === 'container' ? info.Name.replace(/^\//, '') : info.Name;
      const ledger = kind === 'container' ? immutableContainerIds : immutableNetworkIds;
      const expectedId = ledger.get(name);
      if (expectedId) assert.equal(info.Id, expectedId, `${kind} replacement detected for ${name}`);
      verifyOwnership(info);
      if (kind === 'container') await resource.remove({ force: true }); else await resource.remove();
      await requireDockerAbsent(resource, `${kind} ${item.Id}`);
      ledger.delete(name);
    } catch (error) {
      errors.push(`${item.Id}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

async function cleanup() {
  const errors = [];
  const attempt = async (label, task) => {
    try { await task(); } catch (error) { errors.push(`${label}: ${error.message}`); }
  };
  for (const [name, role] of [
    [GID_HELPER, 'socket-gid'], [RESTORE_OK, 'restore'],
    [RESTORE_BAD, 'wrong-restore'], [MGR, 'manager'],
  ]) {
    await attempt(name, () => removeExactContainer(name, (info) => {
      assert.ok(hasLabels(info.Config?.Labels, directLabels(role)));
    }));
  }
  await attempt('instance container', () => removeExactContainer(`tle-nr-${ID}`, (info) => {
    assert.ok(hasLabels(info.Config?.Labels, { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID }));
  }));
  await attempt('direct container scope', async () => {
    await cleanupScope(await listDirectContainers(), 'container', (info) => {
      assert.equal(info.Config?.Labels?.[RUN_LABEL], RUN_ID);
      assert.equal(info.Config?.Labels?.[INSTANCE_LABEL], ID);
      assert.ok(['socket-gid', 'manager', 'restore', 'wrong-restore']
        .includes(info.Config?.Labels?.[ROLE_LABEL]));
    });
    assert.deepEqual(await listDirectContainers(), []);
  });
  await attempt('managed container scope', async () => {
    await cleanupScope(await listManagedContainers(), 'container', (info) => {
      assert.equal(info.Name, `/tle-nr-${ID}`);
      assert.ok(hasLabels(info.Config?.Labels, { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID }));
    });
    assert.deepEqual(await listManagedContainers(), []);
  });
  await attempt('instance network', () => removeExactNetwork(INSTANCE_NETWORK, (info) => {
    assert.ok(hasLabels(info.Labels, { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID }));
  }));
  await attempt('direct network scope', async () => {
    await cleanupScope(await listDirectNetworks(), 'network', (info) => {
      assert.equal(info.Labels?.[RUN_LABEL], RUN_ID);
      assert.equal(info.Labels?.[INSTANCE_LABEL], ID);
    });
    assert.deepEqual(await listDirectNetworks(), []);
  });
  await attempt('managed network scope', async () => {
    await cleanupScope(await listManagedNetworks(), 'network', (info) => {
      assert.equal(info.Name, INSTANCE_NETWORK);
      assert.ok(hasLabels(info.Labels, { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID }));
    });
    assert.deepEqual(await listManagedNetworks(), []);
  });
  await attempt('resource ledgers', async () => {
    assert.equal(immutableContainerIds.size, 0);
    assert.equal(immutableNetworkIds.size, 0);
  });
  await attempt('run root', removeRunRoot);
  await attempt('protected baseline', async () => {
    if (protectedBefore) assert.deepEqual(await protectedSnapshot(), protectedBefore);
  });
  if (errors.length) throw new Error(`verifier cleanup failed: ${errors.join('; ')}`);
}

async function main() {
  console.log(`\n──── Manager 容器化 · 真实 Docker 验证（前缀 ${BASE || '/'}）────\n`);
  protectedBefore = await protectedSnapshot();
  IMAGE = await resolveManagerImage();
  [PORT, INSTANCE_PORT_A, INSTANCE_PORT_B] = await Promise.all([
    allocatePort(), allocatePort(), allocatePort(),
  ]);
  assert.equal(new Set([PORT, INSTANCE_PORT_A, INSTANCE_PORT_B]).size, 3);
  ORIGIN = `http://127.0.0.1:${PORT}`;
  B = `${ORIGIN}${BASE}`;
  await createRunRoot();
  assert.deepEqual(await listDirectContainers(), []);
  assert.deepEqual(await listManagedContainers(), []);
  assert.deepEqual(await listDirectNetworks(), []);
  assert.deepEqual(await listManagedNetworks(), []);

  const gid = await socketGid();
  console.log(`  · 启动 Manager 容器（docker.sock 属组 gid=${gid}）…`);
  sh('docker', [
    'run', '-d', '--name', MGR,
    '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${INSTANCE_LABEL}=${ID}`,
    '--label', `${ROLE_LABEL}=manager`,
    '--group-add', gid,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
    // 同名挂载：容器内路径必须等于宿主路径。Manager 用容器内视角 mkdir 实例数据目录，
    // 而 daemon 用宿主视角解析实例的 Binds —— 不同名就会各写各的，且毫无症状。
    '-v', `${TEST_EDGE_ROOT}:${TEST_EDGE_ROOT}`,
    '-p', `127.0.0.1:${PORT}:19100`,
    '-e', `EDGE_DATA_ROOT=${TEST_EDGE_ROOT}`,
    '-e', `EXTERNAL_URL=${B}`,
    '-e', `MASTER_KEY=${MASTER_KEY}`,
    '-e', `INITIAL_PASSWORD=${ADMIN_PW}`,
    '-e', `INSTANCE_NETWORK=${NET}`,
    '-e', `INSTANCE_PORT_MIN=${Math.min(INSTANCE_PORT_A, INSTANCE_PORT_B)}`,
    '-e', `INSTANCE_PORT_MAX=${Math.max(INSTANCE_PORT_A, INSTANCE_PORT_B)}`,
    '-e', `ALLOWED_IMAGE_TAGS=${TAG}`,
    // 故意不给 MANAGER_CONTAINER：走 /.dockerenv + hostname 的回退分支
    IMAGE,
  ]);
  const managerInfo = await captureContainer(MGR, directLabels('manager'));
  check('显式 MANAGER_IMAGE 已解析并固定为不可变镜像 ID', managerInfo.Image === IMAGE);

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
  const dbPath = `${TEST_EDGE_ROOT}/manager/edge.db`;
  const dbOnHost = (await lstat(dbPath)).isFile();
  check('库文件落在宿主数据根上，不在容器可写层', dbOnHost, dbPath);

  const whoami = sh('docker', ['exec', MGR, 'id', '-un']).trim();
  check('容器内进程不是 root', whoami === 'node', `user=${whoami}`);

  // 登录
  const sess = await adminSession(B, ADMIN_PW, ADMIN_NEXT_PW);
  const { cookie, csrf } = sess;
  const login = { status: sess.status };
  check('登录成功', sess.ok && login.status === 200 && Boolean(csrf), `HTTP ${login.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const storeResponse = await fetch(`${B}/api/nodes/store`, { headers: { cookie } });
  const storeBody = await storeResponse.json();
  const catalogResponse = await fetch(`${B}/api/nodes/catalog`, { headers: { cookie } });
  const catalogBody = await catalogResponse.json();
  check('平台 Edge/common 固定包与批准基线已启动',
    storeResponse.status === 200 && catalogResponse.status === 200
      && storeBody.packages.some((entry) => (
        entry.module === PLATFORM_NODE_PACKAGE.name
          && entry.versions.includes(PLATFORM_NODE_PACKAGE.version)
      ))
      && storeBody.packages.some((entry) => (
        entry.module === PLATFORM_COMMON_PACKAGE.name
          && entry.versions.includes(PLATFORM_COMMON_PACKAGE.version)
      ))
      && catalogBody.entries.some((entry) => (
        entry.module === PLATFORM_NODE_PACKAGE.name
          && entry.version === PLATFORM_NODE_PACKAGE.version
      )));
  assert.equal(await inspectOrAbsent(raw.getContainer(`tle-nr-${ID}`)), undefined);
  assert.equal(await inspectOrAbsent(raw.getNetwork(INSTANCE_NETWORK)), undefined);
  try {
    await lstat(join(TEST_DATA_ROOT, ID));
    throw new Error('random instance data root already exists');
  } catch (error) {
    if (!isFsNotFound(error)) throw error;
  }
  const resourceProbe = JSON.parse(sh('docker', [
    'exec', MGR, 'node', '--input-type=module', '-e',
    `import Docker from 'dockerode'; import { lstat } from 'node:fs/promises';
     const docker = new Docker();
     const code = async (promise) => promise.then(() => 200).catch((error) => error.statusCode ?? -1);
     const pathCode = await lstat(${JSON.stringify(join(TEST_DATA_ROOT, ID))})
       .then(() => 200).catch((error) => error.code === 'ENOENT' ? 404 : -1);
     console.log(JSON.stringify({
       container: await code(docker.getContainer(${JSON.stringify(`tle-nr-${ID}`)}).inspect()),
       network: await code(docker.getNetwork(${JSON.stringify(INSTANCE_NETWORK)}).inspect()),
       data: pathCode,
     }));`,
  ]));
  check('Manager 容器视角的 bootstrap 三类资源均不存在',
    resourceProbe.container === 404 && resourceProbe.network === 404 && resourceProbe.data === 404,
    JSON.stringify(resourceProbe));

  // 创建实例
  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    // 两条不连号映射，且第二条绑到全部网卡 —— 现场设备要连的就是这种
    body: JSON.stringify({ id: ID, name: '容器化验证', imageTag: TAG,
                           ports: [
                             { hostPort: INSTANCE_PORT_A, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT broker' },
                             { hostPort: INSTANCE_PORT_B, containerPort: 502, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'Modbus TCP' },
                           ] }),
  });
  const createdText = await created.text();
  check('通过容器内 Manager 创建实例', created.status === 201,
    `HTTP ${created.status}${created.status === 201 ? '' : ` ${createdText.slice(0, 200)}`}`);

  // 端口字段名写错会被服务端静默忽略，只断言 201 是看不出来的
  const createdPorts = JSON.parse(createdText).instance.ports;
  check('端口映射逐条落到宿主，容器端口不被改写', createdPorts.length === 2
          && createdPorts.some((p) => p.hostPort === INSTANCE_PORT_A && p.containerPort === 1883)
          && createdPorts.some((p) => p.hostPort === INSTANCE_PORT_B && p.containerPort === 502),
        createdPorts.map((p) => `${p.hostPort}→${p.containerPort}`).join(' ') || '一个都没有');

  // 这条是本次修复的要害：早先 hostIp 前端从不发送，永远绑 127.0.0.1，
  // 于是现场设备根本连不上，而界面上一切正常
  const nrInfo = await captureContainer(`tle-nr-${ID}`, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
  });
  const bindings = nrInfo.HostConfig.PortBindings ?? {};
  check('指定的监听网卡真的传到了 Docker',
        bindings['1883/tcp']?.[0]?.HostIp === '127.0.0.1'
          && bindings['502/tcp']?.[0]?.HostIp === '127.0.0.1',
        JSON.stringify(bindings));

  // 时区：官方镜像默认 UTC，不注入 TZ 的话定时流程与时间戳整体偏移且不报错
  const tzOut = (await raw.getContainer(`tle-nr-${ID}`).inspect()).Config.Env
    .find((e) => e.startsWith('TZ='));
  check('实例容器注入了时区，不再跑在 UTC 上', tzOut === 'TZ=Asia/Shanghai', String(tzOut));

  // Manager 是否真的接入了实例网络
  const netInfo = await captureNetwork(INSTANCE_NETWORK, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
  });
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
  const nodesManifest = `${TEST_DATA_ROOT}/${ID}/.config.nodes.json`;
  let manifest = null;
  for (let i = 0; i < 40 && manifest === null; i++) {
    await sleep(500);
    try {
      manifest = JSON.parse(await readFile(nodesManifest, 'utf8'));
    } catch (error) {
      if (!isFsNotFound(error)) throw error;
    }
  }
  const registered = manifest
    ? Object.values(manifest).flatMap((m) => Object.entries(m.nodes ?? {}))
        .filter(([name]) => name.startsWith('tl-'))
    : [];
  check('Node-RED 真的加载了三个 ThingLinks 平台节点',
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
  const backupType = bkRes.headers.get('content-type') ?? '';
  check('备份可下载且是 tar', bkRes.status === 200 &&
        backupType.includes('x-tar') && bkBuf.length > 1024,
        `HTTP ${bkRes.status} ${backupType || '(no type)'} · ${bkBuf.length} 字节`
          + (bkRes.status === 200 ? '' : ` · ${bkBuf.toString('utf8').slice(0, 180)}`));

  const { readManifest } = await import('../dist/core/archive/backup.js');
  const bkManifest = readManifest(bkBuf);
  check('备份清单含实例与 MASTER_KEY 指纹',
        bkManifest.instances.some((i) => i.id === ID) &&
        typeof bkManifest.masterKeyFingerprint === 'string' &&
        bkManifest.masterKeyFingerprint.length === 16,
        `${bkManifest.instances.length} 个实例 · 指纹 ${bkManifest.masterKeyFingerprint}`);

  // 「另一台机器」：全新数据根，把备份文件放进去
  const otherRoot = join(RUN_ROOT, 'restore-data');
  await mkdir(`${otherRoot}/manager`, { recursive: true, mode: 0o777 });
  await mkdir(`${otherRoot}/instances`, { recursive: true, mode: 0o777 });
  await chmod(otherRoot, 0o777);
  await chmod(`${otherRoot}/manager`, 0o777);
  await chmod(`${otherRoot}/instances`, 0o777);
  await writeFile(`${otherRoot}/backup.tar`, bkBuf, { mode: 0o644 });
  sh('docker', ['run', '--name', RESTORE_OK,
      '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${INSTANCE_LABEL}=${ID}`,
      '--label', `${ROLE_LABEL}=restore`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '-v', `${otherRoot}:${otherRoot}`,
      '-e', `EXTERNAL_URL=${B}`, '-e', `MASTER_KEY=${MASTER_KEY}`,
      '-e', `EDGE_DATA_ROOT=${otherRoot}`,
      IMAGE, 'node', 'dist/index.js', 'restore', `${otherRoot}/backup.tar`]);
  await captureContainer(RESTORE_OK, directLabels('restore'));
  await removeExactContainer(RESTORE_OK, (info) => {
    assert.ok(hasLabels(info.Config?.Labels, directLabels('restore')));
  });

  const { openDb } = await import('../dist/core/db.js');
  const { deriveKey } = await import('../dist/core/auth/crypto.js');
  const { InstanceRepo } = await import('../dist/core/instance/repo.js');
  const restoredDb = openDb(`${otherRoot}/manager/edge.db`);
  const restoredRepo = new InstanceRepo(restoredDb, deriveKey(MASTER_KEY, 'thinglinks-edge:instance-cred'));
  check('异机恢复后实例记录回来了',
        restoredRepo.get(ID) !== undefined, restoredRepo.list().map((i) => i.id).join(' '));
  check('异机恢复后实例凭据仍能解开（MASTER_KEY 一致）',
        (restoredRepo.credentials(ID)[0]?.password ?? '').length >= 20,
        restoredRepo.credentials(ID)[0] ? '可解密' : '解不开');
  restoredDb.close();

  check('实例的流程文件也跟着回来',
        (await lstat(`${otherRoot}/instances/${ID}/settings.js`)).isFile());

  // 密钥不对时必须当场失败，而不是恢复出「能启动但实例全起不来」的系统
  const wrongRoot = join(RUN_ROOT, 'wrong-key-data');
  await mkdir(`${wrongRoot}/manager`, { recursive: true, mode: 0o777 });
  await mkdir(`${wrongRoot}/instances`, { recursive: true, mode: 0o777 });
  await chmod(wrongRoot, 0o777);
  await chmod(`${wrongRoot}/manager`, 0o777);
  await chmod(`${wrongRoot}/instances`, 0o777);
  await writeFile(`${wrongRoot}/backup.tar`, bkBuf, { mode: 0o644 });
  let keyRefused = false;
  try {
    sh('docker', ['run', '--name', RESTORE_BAD,
        '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${INSTANCE_LABEL}=${ID}`,
        '--label', `${ROLE_LABEL}=wrong-restore`, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
        '-v', `${wrongRoot}:${wrongRoot}`,
        '-e', `EXTERNAL_URL=${B}`, '-e', `MASTER_KEY=${WRONG_MASTER_KEY}`,
        '-e', `EDGE_DATA_ROOT=${wrongRoot}`,
        IMAGE, 'node', 'dist/index.js', 'restore', `${wrongRoot}/backup.tar`], { stdio: 'pipe' });
  } catch (e) {
    keyRefused = /MASTER_KEY 与备份不符/.test(String(e.stderr ?? e.stdout ?? e.message));
  }
  await captureContainer(RESTORE_BAD, directLabels('wrong-restore'));
  await removeExactContainer(RESTORE_BAD, (info) => {
    assert.ok(hasLabels(info.Config?.Labels, directLabels('wrong-restore')));
  });
  check('MASTER_KEY 不符时拒绝恢复并说清原因', keyRefused);

  // ── 网络回收 ──
  const del = await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: H });
  check('删除实例返回成功', del.status === 204, `HTTP ${del.status}`);
  const recordedContainerId = immutableContainerIds.get(`tle-nr-${ID}`);
  const recordedNetworkId = immutableNetworkIds.get(INSTANCE_NETWORK);
  assert.ok(recordedContainerId && recordedNetworkId);
  await requireDockerAbsent(raw.getContainer(recordedContainerId), 'deleted instance container');
  await requireDockerAbsent(raw.getContainer(`tle-nr-${ID}`), 'deleted instance container name');
  await requireDockerAbsent(raw.getNetwork(recordedNetworkId), 'deleted instance network');
  await requireDockerAbsent(raw.getNetwork(INSTANCE_NETWORK), 'deleted instance network name');
  immutableContainerIds.delete(`tle-nr-${ID}`);
  immutableNetworkIds.delete(INSTANCE_NETWORK);
  check('实例网络已回收（Manager 先摘出自己才删得掉）', true);

  await cleanup();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
}

main().catch(async (e) => {
  let cleanupError;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  console.error('\n  验证异常：', e.message,
    cleanupError ? `；清理失败：${cleanupError.message}` : '');
  process.exitCode = 1;
});
