/**
 * 端到端验证：Manager 反代 + 免密跳转 + WebSocket，对接真实 Node-RED 容器。
 *
 * 实例容器保持生产配置原样（1880 不映射宿主），
 * 由一个显式的 socat 边车容器为宿主测试搭桥 —— 这是测试脚手架，不改变生产拓扑。
 *
 * 用法： node scripts/verify-proxy.mjs [basePath]
 */
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';

import { DockerClient } from '../dist/core/instance/docker-client.js';
import { renderSettings } from '../dist/core/instance/settings-template.js';
import { adminRootFor, authTokenKeyFor } from '../dist/core/config.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import {
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
} from '../dist/core/instance/operation-gate.js';
import { ProxySessionRegistry } from '../dist/core/instance/proxy-session-registry.js';
import { NodeStore } from '../dist/core/nodes/store.js';
import { NodeCatalog } from '../dist/core/nodes/catalog.js';
import { PlatformPackageService } from '../dist/core/nodes/platform-package.js';
import { MigrationCheckpointStore } from '../dist/core/nodes/migration-checkpoint.js';
import {
  NodeRedPlatformMigrationAdminActions,
  PlatformMigrationService,
} from '../dist/core/nodes/platform-migration.js';
import {
  assembleInstanceAdminRuntime,
  assemblePlatformOperationBarrier,
} from '../dist/index.js';
import { buildServer } from '../dist/http/app.js';

const BASE_PATH = process.argv[2] ?? '';
const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-role';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const RUN_ID = `proxy-${randomBytes(5).toString('hex')}`;
const ID = `p${randomBytes(5).toString('hex')}`;
const NET = `${RUN_ID}-net`;
const INSTANCE_NET = `${NET}-${ID}`;
const BRIDGE = `${RUN_ID}-bridge`;
const CANONICAL_TMP_PARENT = realpathSync(existsSync('/private/tmp') ? '/private/tmp' : '/tmp');
assert.ok(CANONICAL_TMP_PARENT === '/private/tmp' || CANONICAL_TMP_PARENT === '/tmp');
let RUN_DATA_ROOT;
let DATA_OWNER;
let BRIDGE_PORT;
let MGR_PORT;
const ADMIN_PW = randomBytes(24).toString('base64url');
const ADMIN_NEXT_PW = randomBytes(24).toString('base64url');
const NR_PW = randomBytes(24).toString('base64url');
const NR_CREDENTIAL_SECRET = randomBytes(24).toString('base64url');

const raw = new Docker();
const results = [];
let protectedBefore;
let managerApp;
let managerDb;
const ownedContainerIds = new Map();
const ownedNetworkIds = new Map();
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const requireCheck = (name, ok, detail = '') => {
  check(name, ok, detail);
  if (!ok) throw new Error(`prerequisite failed: ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function websocketOutcome(url, options = {}) {
  return new Promise((resolveOutcome) => {
    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const ws = new WebSocket(url, options);
    timer = setTimeout(() => {
      ws.terminate();
      finish({ kind: 'timeout' });
    }, 6000);
    ws.on('open', () => {
      ws.close();
      finish({ kind: 'open' });
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish({ kind: 'http', status: response.statusCode ?? 0 });
    });
    ws.on('error', (error) => finish({ kind: 'transport', code: error.code ?? error.name }));
    ws.on('close', (code) => finish({ kind: 'closed', code }));
  });
}

const describeWsOutcome = (outcome) => outcome.kind === 'http'
  ? `HTTP ${outcome.status}`
  : `${outcome.kind}${outcome.code === undefined ? '' : `:${outcome.code}`}`;

async function protectedSnapshot() {
  const snapshots = [];
  for (const name of ['thinglinks-edge-manager', 'tle-nr-line-1']) {
    const info = await raw.getContainer(name).inspect().catch((error) => {
      if (error?.statusCode === 404) return undefined;
      throw error;
    });
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

async function inspectOrAbsent(resource) {
  try {
    return await resource.inspect();
  } catch (error) {
    if (error?.statusCode === 404) return undefined;
    throw error;
  }
}

async function requireDockerAbsent(resource, label) {
  const existing = await inspectOrAbsent(resource);
  assert.equal(existing, undefined, `${label} still exists`);
}

async function removeExactContainer(name, verifyOwnership) {
  const expectedId = ownedContainerIds.get(name);
  const named = await inspectOrAbsent(raw.getContainer(expectedId ?? name));
  if (!named) {
    if (expectedId) {
      const replacement = await inspectOrAbsent(raw.getContainer(name));
      assert.equal(replacement, undefined,
        `recorded container ${expectedId} disappeared but ${name} was replaced`);
    }
    ownedContainerIds.delete(name);
    return;
  }
  if (expectedId) assert.equal(named.Id, expectedId, `container id changed for ${name}`);
  assert.equal(named.Name, `/${name}`, `refuse unexpected container name for ${name}`);
  verifyOwnership(named);
  const id = named.Id;
  const exact = await raw.getContainer(id).inspect();
  assert.equal(exact.Id, id);
  verifyOwnership(exact);
  await raw.getContainer(id).remove({ force: true });
  await requireDockerAbsent(raw.getContainer(id), `container ${id}`);
  await requireDockerAbsent(raw.getContainer(name), `container name ${name}`);
  ownedContainerIds.delete(name);
}

async function removeExactNetwork(name, verifyOwnership) {
  const expectedId = ownedNetworkIds.get(name);
  const named = await inspectOrAbsent(raw.getNetwork(expectedId ?? name));
  if (!named) {
    if (expectedId) {
      const replacement = await inspectOrAbsent(raw.getNetwork(name));
      assert.equal(replacement, undefined,
        `recorded network ${expectedId} disappeared but ${name} was replaced`);
    }
    ownedNetworkIds.delete(name);
    return;
  }
  if (expectedId) assert.equal(named.Id, expectedId, `network id changed for ${name}`);
  assert.equal(named.Name, name, `refuse unexpected network name for ${name}`);
  verifyOwnership(named);
  const id = named.Id;
  const exact = await raw.getNetwork(id).inspect();
  assert.equal(exact.Id, id);
  verifyOwnership(exact);
  await raw.getNetwork(id).remove();
  await requireDockerAbsent(raw.getNetwork(id), `network ${id}`);
  await requireDockerAbsent(raw.getNetwork(name), `network name ${name}`);
  ownedNetworkIds.delete(name);
}

async function requirePathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} still exists`);
}

async function assertRunDataRoot() {
  assert.ok(RUN_DATA_ROOT && DATA_OWNER, 'verifier data root is not reserved');
  const canonical = await realpath(RUN_DATA_ROOT);
  assert.equal(dirname(canonical), CANONICAL_TMP_PARENT);
  assert.ok(basename(canonical).startsWith(`${RUN_ID}-`));
  assert.equal(canonical, RUN_DATA_ROOT);
}

async function reserveRunDataRoot() {
  RUN_DATA_ROOT = await mkdtemp(join(CANONICAL_TMP_PARENT, `${RUN_ID}-`));
  RUN_DATA_ROOT = await realpath(RUN_DATA_ROOT);
  DATA_OWNER = join(RUN_DATA_ROOT, '.verifier-owner');
  await assertRunDataRoot();
  await writeFile(DATA_OWNER, RUN_ID, { flag: 'wx', mode: 0o600 });
  // The official Node-RED image runs as uid 1000; this is an isolated verifier root.
  await chmod(RUN_DATA_ROOT, 0o777);
}

async function removeRunDataRoot() {
  if (!RUN_DATA_ROOT) return;
  const stat = await lstat(RUN_DATA_ROOT).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) {
    RUN_DATA_ROOT = undefined;
    DATA_OWNER = undefined;
    return;
  }
  await assertRunDataRoot();
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'refuse untrusted verifier data root');
  const ownerStat = await lstat(DATA_OWNER);
  assert.ok(ownerStat.isFile() && !ownerStat.isSymbolicLink(), 'refuse untrusted data owner');
  assert.equal(await readFile(DATA_OWNER, 'utf8'), RUN_ID, 'refuse foreign verifier data root');
  await rm(RUN_DATA_ROOT, { recursive: true, force: false });
  await requirePathAbsent(RUN_DATA_ROOT, 'verifier data root');
  RUN_DATA_ROOT = undefined;
  DATA_OWNER = undefined;
}

async function scopedContainers() {
  return raw.listContainers({
    all: true,
    filters: { label: [`${RUN_LABEL}=${RUN_ID}`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function cleanupScopedContainers() {
  const errors = [];
  for (const item of await scopedContainers()) {
    try {
      const info = await inspectOrAbsent(raw.getContainer(item.Id));
      if (!info) continue;
      const labels = info.Config?.Labels ?? {};
      assert.equal(labels[RUN_LABEL], RUN_ID);
      assert.equal(labels[INSTANCE_LABEL], ID);
      assert.equal(labels[ROLE_LABEL], 'bridge');
      const name = info.Name.replace(/^\//, '');
      await raw.getContainer(info.Id).remove({ force: true });
      await requireDockerAbsent(raw.getContainer(info.Id), `scoped container ${info.Id}`);
      ownedContainerIds.delete(name);
    } catch (error) {
      errors.push(`${item.Id}: ${error.message}`);
    }
  }
  const remaining = await scopedContainers();
  if (remaining.length > 0) errors.push(`remaining ids: ${remaining.map((item) => item.Id).join(',')}`);
  if (errors.length > 0) throw new Error(`scoped container cleanup failed: ${errors.join('; ')}`);
}

async function scopedNetworks() {
  return raw.listNetworks({
    filters: { label: [`${RUN_LABEL}=${RUN_ID}`, `${INSTANCE_LABEL}=${ID}`] },
  });
}

async function cleanupScopedNetworks() {
  const errors = [];
  for (const item of await scopedNetworks()) {
    try {
      const info = await inspectOrAbsent(raw.getNetwork(item.Id));
      if (!info) continue;
      const labels = info.Labels ?? {};
      assert.equal(labels[RUN_LABEL], RUN_ID);
      assert.equal(labels[INSTANCE_LABEL], ID);
      assert.equal(labels[ROLE_LABEL], 'instance-network');
      await raw.getNetwork(info.Id).remove();
      await requireDockerAbsent(raw.getNetwork(info.Id), `scoped network ${info.Id}`);
      ownedNetworkIds.delete(info.Name);
    } catch (error) {
      errors.push(`${item.Id}: ${error.message}`);
    }
  }
  const remaining = await scopedNetworks();
  if (remaining.length > 0) errors.push(`remaining ids: ${remaining.map((item) => item.Id).join(',')}`);
  if (errors.length > 0) throw new Error(`scoped network cleanup failed: ${errors.join('; ')}`);
}

function assembleRuntime({ db, repo, docker, dataRoot, upstreamFor }) {
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const proxySessions = new ProxySessionRegistry();
  const instanceAdmin = assembleInstanceAdminRuntime({ repo, upstreamFor });
  const platformOperation = assemblePlatformOperationBarrier();
  // This existing-legacy proxy scenario never installs packages. The real
  // service remains fail-closed rather than inventing trusted package bytes.
  const platformPackages = new PlatformPackageService({
    store: new NodeStore(join(dataRoot, 'npm')),
    catalog: new NodeCatalog(db),
  });
  let migrationService;
  const pendingStartCompletion = {
    completePendingStartUnderLease(instanceId, lease, actor) {
      if (!migrationService) throw new Error('migration service is not assembled');
      return migrationService.completePendingStartUnderLease(instanceId, lease, actor);
    },
  };
  const service = new InstanceService({
    ...instanceAdmin.instanceServiceDeps,
    ...platformOperation.instanceServiceDeps,
    db, repo, docker, gate: operationGate,
    instanceDataRoot: RUN_DATA_ROOT,
    platformPackages, pendingStartCompletion,
    basePath: BASE_PATH, portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'], probeHostPorts: false,
    upstreamFor,
  });
  migrationService = new PlatformMigrationService({
    repo, gate: operationGate, proxySessions, docker,
    adminRuntime: instanceAdmin.adminRuntime,
    admin: new NodeRedPlatformMigrationAdminActions(instanceAdmin.adminRuntime),
    platformPackages,
    checkpoint: new MigrationCheckpointStore(RUN_DATA_ROOT),
    settings: service, repair: service, bootstrapRecovery: service,
    ...platformOperation.migrationServiceDeps,
    instanceDataRoot: RUN_DATA_ROOT,
  });
  return {
    service, operationGate, proxySessions, migrationService, platformPackages,
    adminRuntime: instanceAdmin.adminRuntime,
  };
}

async function cleanup() {
  const errors = [];
  const attempt = async (label, task) => {
    try { await task(); } catch (error) { errors.push(`${label}: ${error.message}`); }
  };
  await attempt('Manager close', async () => {
    if (managerApp) await managerApp.close();
    managerApp = undefined;
  });
  await attempt('database close', async () => {
    if (managerDb?.open) managerDb.close();
    managerDb = undefined;
  });
  await attempt('bridge cleanup', () => removeExactContainer(BRIDGE, (info) => {
    assert.equal(info.Config?.Labels?.[RUN_LABEL], RUN_ID);
    assert.equal(info.Config?.Labels?.[INSTANCE_LABEL], ID);
    assert.equal(info.Config?.Labels?.[ROLE_LABEL], 'bridge');
  }));
  await attempt('instance cleanup', () => removeExactContainer(containerName(ID), (info) => {
    assert.equal(info.Config?.Labels?.[MANAGED_LABEL], 'true');
    assert.equal(info.Config?.Labels?.[INSTANCE_LABEL], ID);
  }));
  await attempt('scoped container cleanup', cleanupScopedContainers);
  await attempt('instance network cleanup', () => removeExactNetwork(INSTANCE_NET, (info) => {
    assert.equal(info.Labels?.[MANAGED_LABEL], 'true');
    assert.equal(info.Labels?.[INSTANCE_LABEL], ID);
    assert.equal(info.Labels?.[RUN_LABEL], RUN_ID);
    assert.equal(info.Labels?.[ROLE_LABEL], 'instance-network');
  }));
  await attempt('scoped network cleanup', cleanupScopedNetworks);
  await attempt('data cleanup', removeRunDataRoot);
  await attempt('resource ledger', async () => {
    assert.equal(ownedContainerIds.size, 0, 'owned container ids remain');
    assert.equal(ownedNetworkIds.size, 0, 'owned network ids remain');
  });
  await attempt('protected baseline', async () => {
    if (protectedBefore) assert.deepEqual(await protectedSnapshot(), protectedBefore);
  });
  if (errors.length > 0) throw new Error(`verifier cleanup failed: ${errors.join('; ')}`);
}

async function main() {
  console.log(`\n──── 反代端到端验证（basePath=${BASE_PATH || '(根路径)'}）────\n`);
  protectedBefore = await protectedSnapshot();
  await reserveRunDataRoot();
  BRIDGE_PORT = await freePort();
  do { MGR_PORT = await freePort(); } while (MGR_PORT === BRIDGE_PORT);

  const adminRoot = adminRootFor(BASE_PATH, ID);
  const instanceNetwork = await raw.createNetwork({
    Name: INSTANCE_NET, Driver: 'bridge', Internal: false,
    Labels: {
      [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
      [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'instance-network',
    },
  });
  const instanceNetworkInfo = await instanceNetwork.inspect();
  assert.equal(instanceNetworkInfo.Id, instanceNetwork.id);
  assert.equal(instanceNetworkInfo.Labels?.[RUN_LABEL], RUN_ID);
  ownedNetworkIds.set(INSTANCE_NET, instanceNetworkInfo.Id);
  const client = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: RUN_DATA_ROOT, timezone: 'Asia/Shanghai',
  });

  await client.createInstance({
    id: ID, imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5, ports: [], adminRoot,
  }, renderSettings({
    instanceId: ID, adminRoot, credentialSecret: NR_CREDENTIAL_SECRET,
    credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync(NR_PW, 8), permissions: '*' }],
    nodeRuntimeMode: 'legacy',
  }), 'legacy');
  const instanceInfo = await raw.getContainer(containerName(ID)).inspect();
  assert.equal(instanceInfo.Config?.Labels?.[MANAGED_LABEL], 'true');
  assert.equal(instanceInfo.Config?.Labels?.[INSTANCE_LABEL], ID);
  ownedContainerIds.set(containerName(ID), instanceInfo.Id);
  await client.start(ID);

  let ready = false;
  for (let i = 0; i < 45 && !ready; i++) {
    await sleep(1000);
    ready = (await client.logs(ID, 50)).includes('Server now running at');
  }
  check('真实 Node-RED 实例就绪', ready);
  if (!ready) throw new Error('实例未就绪');

  // 测试脚手架：实例 1880 不映射宿主，用边车转发给宿主测试
  const instNet = client.instanceNetwork(ID);
  const bridge = await raw.createContainer({
    name: BRIDGE, Image: 'alpine/socat',
    User: '65534:65534',
    Cmd: [`TCP-LISTEN:${BRIDGE_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    Labels: { [RUN_LABEL]: RUN_ID, [INSTANCE_LABEL]: ID, [ROLE_LABEL]: 'bridge' },
    ExposedPorts: { [`${BRIDGE_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: instNet,
      PortBindings: { [`${BRIDGE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(BRIDGE_PORT) }] },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=8m' },
    },
  });
  const bridgeInfo = await bridge.inspect();
  assert.equal(bridgeInfo.Config?.Labels?.[RUN_LABEL], RUN_ID);
  ownedContainerIds.set(BRIDGE, bridgeInfo.Id);
  await bridge.start();
  await sleep(1500);

  // Manager：注入宿主可达的上游（生产默认按容器名解析）
  const runtimeRoot = join(RUN_DATA_ROOT, 'manager');
  await mkdir(runtimeRoot, { mode: 0o700 });
  const db = openDb(join(runtimeRoot, 'edge.db'));
  managerDb = db;
  const key = deriveKey('verify-master', 'salt');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  repo.create(
    {
      id: ID, name: '验证实例', imageTag: '5.0.4-24-minimal', memLimit: 256,
      cpuLimit: 0.5, adminRoot, credSecret: NR_CREDENTIAL_SECRET, notes: '',
    },
    [],
    [{ username: 'admin', password: NR_PW, permissions: '*' }],
  );

  const upstreamFor = () => `http://127.0.0.1:${BRIDGE_PORT}`;
  const runtime = assembleRuntime({ db, repo, docker: client, dataRoot: runtimeRoot, upstreamFor });
  const config = {
    externalUrl: `http://127.0.0.1:${MGR_PORT}${BASE_PATH}`,
    basePath: BASE_PATH, cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${MGR_PORT}`],
    listenAddr: '127.0.0.1', listenPort: MGR_PORT,
    dataDir: runtimeRoot, dataRoot: runtimeRoot, instanceDataRoot: RUN_DATA_ROOT,
    portRange: { min: 30000, max: 30999 },
    timezone: 'Asia/Shanghai', updateCheckUrl: '',
  };
  const app = buildServer({
    config, db, auth, repo,
    service: runtime.service,
    operationGate: runtime.operationGate,
    migrationService: runtime.migrationService,
    proxySessions: runtime.proxySessions,
    adminRuntime: runtime.adminRuntime,
    platformPackages: runtime.platformPackages,
    upstreamFor,
  });
  managerApp = app;
  await app.listen({ host: '127.0.0.1', port: MGR_PORT });

  const B = `http://127.0.0.1:${MGR_PORT}${BASE_PATH}`;

  // 1. 未登录被拒
  check('未登录访问实例被拒绝', (await fetch(`${B}/red/${ID}/`, { redirect: 'manual' })).status === 401);

  // 2. 登录
  const login = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PW }),
  });
  const jar = (res) => (res.headers.get('set-cookie') ?? '')
    .split(',').map((c) => c.split(';')[0].trim()).join('; ');
  const first = jar(login);
  requireCheck('管理面登录成功', login.status === 200 && first.includes('tle_sid'));

  /*
   * 必须先改掉初始口令再往下走。
   *
   * 强制改密现在是**后端闸门**（guard 与反代都判），不再只由前端路由引导 ——
   * 拿初始口令的会话调任何业务接口、开任何实例编辑器都会 403。
   * 这段是补上「真实用户本来就要做的第一步」，不是为了绕过检查。
   */
  const csrf = /tle_csrf=([^;]+)/.exec(first)?.[1] ?? '';
  const changed = await fetch(`${B}/api/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: first, 'x-csrf-token': csrf },
    body: JSON.stringify({ oldPassword: ADMIN_PW, newPassword: ADMIN_NEXT_PW }),
  });
  assert.equal(changed.status, 204, 'initial password change failed');
  const relogin = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_NEXT_PW }),
  });
  const cookie = jar(relogin);
  requireCheck('首次强制改密后可正常使用', relogin.status === 200 && cookie.includes('tle_sid'),
    `HTTP ${relogin.status}`);

  // 3. 编辑器
  const editor = await fetch(`${B}/red/${ID}/`, { headers: { cookie } });
  const html = await editor.text();
  requireCheck('真实编辑器 HTML 可加载', editor.status === 200 && html.includes('red/red.min.js'),
    `HTTP ${editor.status}`);

  // 4. 静态资源（真实 Node-RED 用相对路径，按文档 URL 解析）
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith('http') && /\.(js|css)/.test(u)).slice(0, 6);
  const refPaths = refs.map((ref) => new URL(ref, `${B}/red/${ID}/`).pathname);
  const hasJs = refPaths.some((path) => path.endsWith('.js'));
  const hasCss = refPaths.some((path) => path.endsWith('.css'));
  const fails = [];
  for (const rel of refs) {
    const abs = new URL(rel, `${B}/red/${ID}/`).toString();
    const r = await fetch(abs, { headers: { cookie } });
    if (r.status !== 200) fails.push(`${rel}→${r.status}`);
  }
  check(`静态资源可取回（抽查 ${refs.length} 个）`,
    hasJs && hasCss && fails.length === 0,
    fails.join(',') || `JS=${hasJs ? 'yes' : 'no'} CSS=${hasCss ? 'yes' : 'no'} · ${refPaths.join(', ')}`);

  // 5. 无尾斜杠 301
  const noSlash = await fetch(`${B}/red/${ID}`, { headers: { cookie }, redirect: 'manual' });
  check('无尾斜杠被 301 重定向', noSlash.status >= 300 && noSlash.status < 400,
        `HTTP ${noSlash.status} → ${noSlash.headers.get('location') ?? ''}`);

  // 6. WebSocket
  const wsUrl = `ws://127.0.0.1:${MGR_PORT}${BASE_PATH}/red/${ID}/comms`;
  const wsOk = await websocketOutcome(wsUrl, {
    headers: { cookie, origin: `http://127.0.0.1:${MGR_PORT}` },
  });
  check('真实 /comms WebSocket 握手成功', wsOk.kind === 'open', describeWsOutcome(wsOk));

  // 7. 未鉴权 WebSocket 必须被拒
  const wsNoAuth = await websocketOutcome(wsUrl);
  check('未鉴权 WebSocket 被拒绝',
    wsNoAuth.kind === 'http' && wsNoAuth.status === 401,
    describeWsOutcome(wsNoAuth));

  // 8. 伪造 Origin 必须被拒（CSWSH）
  const wsBadOrigin = await websocketOutcome(wsUrl, {
    headers: { cookie, origin: 'http://evil.example.com' },
  });
  check('伪造 Origin 的 WebSocket 被拒绝',
    wsBadOrigin.kind === 'http' && wsBadOrigin.status === 403,
    describeWsOutcome(wsBadOrigin));

  // 9. 免密跳转
  const sso = await fetch(`${B}/red/${ID}/sso`, { headers: { cookie } });
  const ssoHtml = await sso.text();
  const token = (ssoHtml.match(/\\?"access_token\\?":\\?"([^"\\]+)/) ?? [])[1];
  requireCheck('免密跳转取得真实 access_token', sso.status === 200 && Boolean(token),
    token ? 'token present' : `HTTP ${sso.status}`);

  // 10. 存储键必须按 httpAdminRoot 命名空间化
  const expectKey = authTokenKeyFor(adminRoot);
  check('token 存储键按 httpAdminRoot 命名空间化', ssoHtml.includes(`"${expectKey}"`), expectKey);

  // 11. token 可调真实 admin API
  const api = await fetch(`${B}/red/${ID}/flows`, { headers: { cookie, authorization: `Bearer ${token}` } });
  check('用该 token 调真实 admin API /flows', api.status === 200, `HTTP ${api.status}`);

  // 12. 无 token 时实例自身拒绝（纵深防御）
  const bare = await fetch(`${B}/red/${ID}/flows`, { headers: { cookie } });
  check('无 token 调 admin API 被实例自身拒绝', bare.status === 401, `HTTP ${bare.status}（实例侧 adminAuth 生效）`);

  // 13. 流程自己提供的路径必须带 CSP
  /*
   * 实例的 httpNodeRoot 是 `<adminRoot>api/`，与管理台**同源**。
   * `http in` / Function 节点能在那里返回任意 HTML+JS，那段脚本带着管理员 Cookie，
   * 还读得到双提交用的 CSRF Cookie —— 同源之内没有任何 Token 技巧挡得住。
   *
   * 所以给这一段加 CSP，把 connect-src 限死在实例自己的流程路径上：
   * 流程页面照样能调自己的后端，但 fetch('/api/users') 会被浏览器拒掉。
   */
  const flowRes = await fetch(`${B}/red/${ID}/api/anything`, { headers: { cookie } });
  const csp = flowRes.headers.get('content-security-policy') ?? '';
  check('流程提供的路径带 CSP', csp !== '', csp.slice(0, 60) || '（没有）');
  check('CSP 把 connect-src 限死在本实例流程路径',
        csp.includes(`connect-src `) && csp.includes(`/red/${ID}/api/`) &&
        !/connect-src[^;]*'self'/.test(csp),
        csp.match(/connect-src[^;]*/)?.[0] ?? '（无 connect-src）');
  check('CSP 同时封掉表单提交（否则 form POST 绕过 connect-src）',
        /form-action\s+'none'/.test(csp), csp.includes('form-action') ? '有' : '没有');
  check('流程路径禁止内容嗅探', flowRes.headers.get('x-content-type-options') === 'nosniff');

  // 编辑器自身不加 CSP —— 那是平台自己的界面，加了会把它拆坏
  const edRes = await fetch(`${B}/red/${ID}/`, { headers: { cookie } });
  check('编辑器本身不受 CSP 影响',
        !edRes.headers.get('content-security-policy'),
        edRes.headers.get('content-security-policy') ?? '（无，符合预期）');

  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  let cleanupError;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  console.error('\n验证失败：', e.message,
    cleanupError ? `；清理失败：${cleanupError.message}` : '');
  process.exit(1);
});
