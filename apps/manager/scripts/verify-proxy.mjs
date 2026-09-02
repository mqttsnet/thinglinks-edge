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
import { access, chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';

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
import { TEST_DATA_ROOT, ensureRoot } from './_data-root.mjs';

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
const RUN_DATA_ROOT = `${TEST_DATA_ROOT}/${RUN_ID}`;
const DATA_OWNER = `${RUN_DATA_ROOT}/.verifier-owner`;
let BRIDGE_PORT;
let MGR_PORT;
const ADMIN_PW = 'initial-password-123';
const NR_PW = 'nr-secret';

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

async function removeExactContainer(name, verifyOwnership) {
  const expectedId = ownedContainerIds.get(name);
  const named = await raw.getContainer(expectedId ?? name).inspect().catch((error) => {
    if (error?.statusCode === 404) return undefined;
    throw error;
  });
  if (!named) {
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
  assert.equal(await raw.getContainer(id).inspect().then(() => true).catch(() => false), false);
  ownedContainerIds.delete(name);
}

async function removeExactNetwork(name, verifyOwnership) {
  const expectedId = ownedNetworkIds.get(name);
  const named = await raw.getNetwork(expectedId ?? name).inspect().catch((error) => {
    if (error?.statusCode === 404) return undefined;
    throw error;
  });
  if (!named) {
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
  assert.equal(await raw.getNetwork(id).inspect().then(() => true).catch(() => false), false);
  ownedNetworkIds.delete(name);
}

function assertRunDataRoot() {
  const base = resolve(TEST_DATA_ROOT);
  assert.ok(base.startsWith('/private/tmp/') || base.startsWith('/tmp/'),
    `refuse non-temporary verifier data root: ${base}`);
  assert.equal(resolve(RUN_DATA_ROOT), join(base, RUN_ID));
}

async function reserveRunDataRoot() {
  assertRunDataRoot();
  await mkdir(RUN_DATA_ROOT, { mode: 0o700 });
  await writeFile(DATA_OWNER, RUN_ID, { flag: 'wx', mode: 0o600 });
  // The official Node-RED image runs as uid 1000; this is an isolated verifier root.
  await chmod(RUN_DATA_ROOT, 0o777);
}

async function removeRunDataRoot() {
  assertRunDataRoot();
  const stat = await lstat(RUN_DATA_ROOT).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return;
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'refuse untrusted verifier data root');
  assert.equal(await readFile(DATA_OWNER, 'utf8'), RUN_ID, 'refuse foreign verifier data root');
  await rm(RUN_DATA_ROOT, { recursive: true, force: false });
  assert.equal(await access(RUN_DATA_ROOT).then(() => true).catch(() => false), false);
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
    assert.equal(info.Config?.Labels?.[ROLE_LABEL], 'bridge');
  }));
  await attempt('instance cleanup', () => removeExactContainer(containerName(ID), (info) => {
    assert.equal(info.Config?.Labels?.[MANAGED_LABEL], 'true');
    assert.equal(info.Config?.Labels?.[INSTANCE_LABEL], ID);
  }));
  await attempt('instance network cleanup', () => removeExactNetwork(INSTANCE_NET, (info) => {
    assert.equal(info.Labels?.[MANAGED_LABEL], 'true');
    assert.equal(info.Labels?.[INSTANCE_LABEL], ID);
    assert.equal(info.Labels?.[RUN_LABEL], RUN_ID);
    assert.equal(info.Labels?.[ROLE_LABEL], 'instance-network');
  }));
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
  await ensureRoot();
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
    instanceId: ID, adminRoot, credentialSecret: 'cs',
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
    Labels: { [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'bridge' },
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
    { id: ID, name: '验证实例', imageTag: '5.0.4-24-minimal', memLimit: 256, cpuLimit: 0.5, adminRoot, credSecret: 'cs', notes: '' },
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
    body: JSON.stringify({ oldPassword: ADMIN_PW, newPassword: 'proxy-verify-pass-1' }),
  });
  assert.equal(changed.status, 204, 'initial password change failed');
  const relogin = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'proxy-verify-pass-1' }),
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
  const fails = [];
  for (const rel of refs) {
    const abs = new URL(rel, `${B}/red/${ID}/`).toString();
    const r = await fetch(abs, { headers: { cookie } });
    if (r.status !== 200) fails.push(`${rel}→${r.status}`);
  }
  check(`静态资源可取回（抽查 ${refs.length} 个）`, fails.length === 0, fails.join(',') || refs.map((r) => r.split('?')[0]).join(', '));

  // 5. 无尾斜杠 301
  const noSlash = await fetch(`${B}/red/${ID}`, { headers: { cookie }, redirect: 'manual' });
  check('无尾斜杠被 301 重定向', noSlash.status >= 300 && noSlash.status < 400,
        `HTTP ${noSlash.status} → ${noSlash.headers.get('location') ?? ''}`);

  // 6. WebSocket
  const wsUrl = `ws://127.0.0.1:${MGR_PORT}${BASE_PATH}/red/${ID}/comms`;
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: `http://127.0.0.1:${MGR_PORT}` } });
    const t = setTimeout(() => { ws.terminate(); resolve(false); }, 6000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
  check('真实 /comms WebSocket 握手成功', wsOk);

  // 7. 未鉴权 WebSocket 必须被拒
  const wsNoAuth = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.terminate(); resolve('超时'); }, 5000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve('竟然连上'); });
    ws.on('error', (e) => { clearTimeout(t); resolve(e.message); });
  });
  check('未鉴权 WebSocket 被拒绝', wsNoAuth !== '竟然连上', String(wsNoAuth).slice(0, 46));

  // 8. 伪造 Origin 必须被拒（CSWSH）
  const wsBadOrigin = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: 'http://evil.example.com' } });
    const t = setTimeout(() => { ws.terminate(); resolve('超时'); }, 5000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve('竟然连上'); });
    ws.on('error', (e) => { clearTimeout(t); resolve(e.message); });
  });
  check('伪造 Origin 的 WebSocket 被拒绝', wsBadOrigin !== '竟然连上', String(wsBadOrigin).slice(0, 46));

  // 9. 免密跳转
  const sso = await fetch(`${B}/red/${ID}/sso`, { headers: { cookie } });
  const ssoHtml = await sso.text();
  const token = (ssoHtml.match(/\\?"access_token\\?":\\?"([^"\\]+)/) ?? [])[1];
  requireCheck('免密跳转取得真实 access_token', sso.status === 200 && Boolean(token),
    token ? `${token.slice(0, 14)}…` : `HTTP ${sso.status}`);

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
