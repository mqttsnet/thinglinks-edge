/**
 * 越权用例 —— 检查点 4 的核心（T4.4）。
 *
 * 这份脚本只做一件事：**逐条尝试越权，确认全部被拒**。
 *
 * 不用真容器：授权判定发生在 HTTP 层，与 Docker 无关；
 * 反代那条链路用一个假上游即可验证「够不够得到」，而不需要真的跑起 Node-RED。
 * 这样它能在几秒内跑完，值得在每次改路由后都跑一遍。
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';

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
import { MetricsHistory } from '../dist/core/health/metrics-history.js';
import { FieldRegistry } from '../dist/core/edge/registry.js';
import { buildServer } from '../dist/http/app.js';
import WebSocket, { WebSocketServer } from 'ws';

let PORT;
let B;
const AUTHZ_RUN_ID = `authz-${randomBytes(5).toString('hex')}`;
const CANONICAL_TMP_PARENT = realpathSync(existsSync('/private/tmp') ? '/private/tmp' : '/tmp');
assert.ok(CANONICAL_TMP_PARENT === '/private/tmp' || CANONICAL_TMP_PARENT === '/tmp');
const randomPassword = () => `Aa1!${randomBytes(20).toString('base64url')}`;
const ADMIN_PW = randomPassword();
const ADMIN_NEXT_PW = randomPassword();
const INSTANCE_PW = randomPassword();
const INSTANCE_SECRET = randomBytes(24).toString('base64url');
const OPERATOR_PW = randomPassword();
const VIEWER_PW = randomPassword();
const PENDING_PW = randomPassword();
const SHIFT_PW = randomPassword();
const WRONG_PW = randomPassword();

const results = [];
let authzApp;
let authzDb;
let authzRoot;
let authzOwner;
let upstreamServer;
let upstreamWebSockets;
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** 假 Docker：授权判定不依赖它，这里只要不炸 */
const fakeDocker = {
  async ensureNetwork() {}, async ensureDataDir() {}, async createInstance() {},
  async start() {}, async stop() {}, async restart() {}, async remove() {},
  async assertManaged() {}, async logs() { return ''; },
  async list() { return []; },
  containerRef() { return { async inspect() { return { State: { Status: 'running', Running: true } }; },
                            async stats() { return {}; } }; },
};

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

function assembleRuntime({ db, repo, docker, dataRoot, upstreamFor }) {
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const proxySessions = new ProxySessionRegistry();
  const instanceAdmin = assembleInstanceAdminRuntime({ repo, upstreamFor });
  const platformOperation = assemblePlatformOperationBarrier();
  // Authz never installs a node package. Keep the real trust service fail-closed
  // instead of fabricating a verifier-only trusted package response.
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
    db, repo, docker, gate: operationGate, instanceDataRoot: dataRoot,
    platformPackages, pendingStartCompletion,
    basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'], probeHostPorts: false,
    upstreamFor,
  });
  migrationService = new PlatformMigrationService({
    repo, gate: operationGate, proxySessions, docker,
    adminRuntime: instanceAdmin.adminRuntime,
    admin: new NodeRedPlatformMigrationAdminActions(instanceAdmin.adminRuntime),
    platformPackages,
    checkpoint: new MigrationCheckpointStore(dataRoot),
    settings: service, repair: service, bootstrapRecovery: service,
    ...platformOperation.migrationServiceDeps,
    instanceDataRoot: dataRoot,
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
    if (authzApp) await authzApp.close();
    authzApp = undefined;
  });
  await attempt('upstream close', () => new Promise((resolve, reject) => {
    for (const client of upstreamWebSockets?.clients ?? []) client.terminate();
    upstreamWebSockets?.close();
    upstreamWebSockets = undefined;
    if (!upstreamServer?.listening) return resolve();
    upstreamServer.close((error) => error ? reject(error) : resolve());
  }));
  upstreamServer = undefined;
  await attempt('database close', async () => {
    if (authzDb?.open) authzDb.close();
    authzDb = undefined;
  });
  await attempt('data cleanup', async () => {
    if (!authzRoot) return;
    let rootStat;
    try {
      rootStat = lstatSync(authzRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      authzRoot = undefined;
      authzOwner = undefined;
      return;
    }
    assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
    assert.equal(realpathSync(authzRoot), authzRoot);
    assert.equal(dirname(authzRoot), CANONICAL_TMP_PARENT);
    assert.ok(basename(authzRoot).startsWith(`${AUTHZ_RUN_ID}-`));
    const ownerStat = lstatSync(authzOwner);
    assert.ok(ownerStat.isFile() && !ownerStat.isSymbolicLink());
    assert.equal(readFileSync(authzOwner, 'utf8'), AUTHZ_RUN_ID);
    rmSync(authzRoot, { recursive: true, force: false });
    try {
      lstatSync(authzRoot);
      throw new Error('authz verifier data root still exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    authzRoot = undefined;
    authzOwner = undefined;
  });
  if (errors.length > 0) throw new Error(`verifier cleanup failed: ${errors.join('; ')}`);
}

async function login(username, password) {
  const res = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) return undefined;
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1];
  return { cookie, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' } };
}

const status = async (path, sess, init = {}) =>
  (await fetch(`${B}${path}`, { ...init, headers: { ...(sess?.headers ?? {}), ...(init.headers ?? {}) } })).status;

async function main() {
  console.log('\n──── 越权用例 · 全拒验证 ────\n');

  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  const dataRoot = realpathSync(mkdtempSync(join(CANONICAL_TMP_PARENT, `${AUTHZ_RUN_ID}-`)));
  assert.equal(dirname(dataRoot), CANONICAL_TMP_PARENT);
  authzRoot = dataRoot;
  authzOwner = join(dataRoot, '.verifier-owner');
  writeFileSync(authzOwner, AUTHZ_RUN_ID, { flag: 'wx', mode: 0o600 });
  const db = openDb(join(dataRoot, 'edge.db'));
  authzDb = db;
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, deriveKey('authz', 'salt'));
  let upstreamUrl = 'http://127.0.0.1:1';
  let upstreamResolveHits = 0;
  const upstreamFor = () => {
    upstreamResolveHits += 1;
    return upstreamUrl;
  };
  const runtime = assembleRuntime({ db, repo, docker: fakeDocker, dataRoot, upstreamFor });

  // 两台实例直接落库，绕开 Docker
  for (const id of ['line-a', 'line-b']) {
    repo.create(
      { id, name: id, imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
        adminRoot: `/red/${id}/`, credSecret: INSTANCE_SECRET, notes: '' },
      [], [{ username: 'admin', password: INSTANCE_PW, permissions: '*' }],
    );
  }

  /*
   * 台账与趋势里都塞两台实例的数据。
   * 这两类是**聚合**接口（一次返回全部实例），guard 按实例拦不住，
   * 只能靠逐条过滤 —— 所以必须有 line-b 的数据在里面才测得出漏没漏。
   */
  const registry = new FieldRegistry(db);
  registry.upsertDevice('line-a', { nodeId: 'n-a', name: 'A 线泵', protocol: 'modbus', address: '10.0.1.5:502' });
  registry.upsertDevice('line-b', { nodeId: 'n-b', name: 'B 线炉', protocol: 'modbus', address: '10.0.2.7:502' });

  const metrics = new MetricsHistory({ fineStepSec: 10 });
  const inst = (cpu) => ({ cpuPercent: cpu, memUsedMb: 64, memPercent: 12, latencyMs: 5, verdict: 'healthy' });
  metrics.record({
    t: Date.now(),
    host: { loadPercent: 10, memPercent: 50, diskPercent: 30 },
    instances: { 'line-a': inst(1), 'line-b': inst(9) },
  });

  // 假上游：反代若放行就会打到它；被拒时它一次都不会被访问到
  let upstreamHits = 0;
  let upstreamUpgradeHits = 0;
  const upstream = createServer((_q, s) => { upstreamHits += 1; s.end('UPSTREAM'); });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWebSockets = upstreamWs;
  upstreamWs.on('connection', (ws) => {
    upstreamUpgradeHits += 1;
    ws.on('error', () => undefined);
  });
  upstreamServer = upstream;
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;

  const app = buildServer({
    config: {
      externalUrl: B, basePath: '', cookieSecure: false, allowedOrigins: [B],
      listenAddr: '127.0.0.1', listenPort: PORT, dataDir: '/tmp',
      dataRoot: '/tmp', instanceDataRoot: '/tmp', portRange: { min: 30000, max: 30999 },
    },
    db, auth, repo, metrics,
    service: runtime.service,
    operationGate: runtime.operationGate,
    migrationService: runtime.migrationService,
    proxySessions: runtime.proxySessions,
    adminRuntime: runtime.adminRuntime,
    platformPackages: runtime.platformPackages,
    upstreamFor,
  });
  authzApp = app;
  await app.listen({ host: '127.0.0.1', port: PORT });

  // ── 准备账号 ──
  const admin = await login('admin', ADMIN_PW);
  assert.ok(admin, 'initial admin login failed');
  const initialChange = await fetch(`${B}/api/change-password`, {
    method: 'POST', headers: admin.headers,
    body: JSON.stringify({ oldPassword: ADMIN_PW, newPassword: ADMIN_NEXT_PW }),
  });
  assert.equal(initialChange.status, 204, 'initial admin password change failed');
  const root = await login('admin', ADMIN_NEXT_PW);
  check('管理员登录并完成首次改密', Boolean(root));
  assert.ok(root, 'admin relogin failed');

  const mk = async (username, role) => {
    const res = await fetch(`${B}/api/users`, {
      method: 'POST', headers: root.headers, body: JSON.stringify({ username, role }),
    });
    assert.ok(res.ok, `create user ${username} failed with HTTP ${res.status}`);
    const body = await res.json();
    assert.equal(typeof body.password, 'string', `create user ${username} returned no password`);
    return body.password;
  };
  const opPw = await mk('lineop', 'operator');
  const viPw = await mk('watcher', 'viewer');
  check('管理员可新建用户并拿到一次性口令', typeof opPw === 'string' && opPw.length >= 20);

  // 只授权 line-a
  const opGrant = await fetch(`${B}/api/users/lineop/grants`, {
    method: 'POST', headers: root.headers,
    body: JSON.stringify({ instanceId: 'line-a', level: 'operate' }),
  });
  assert.equal(opGrant.status, 204, 'operator grant failed');
  const viewerGrant = await fetch(`${B}/api/users/watcher/grants`, {
    method: 'POST', headers: root.headers,
    body: JSON.stringify({ instanceId: 'line-a', level: 'view' }),
  });
  assert.equal(viewerGrant.status, 204, 'viewer grant failed');

  // 新用户首次登录要改密，改完再用
  const useAs = async (username, initial, next) => {
    const s0 = await login(username, initial);
    assert.ok(s0, `${username} initial login failed`);
    const changed = await fetch(`${B}/api/change-password`, {
      method: 'POST', headers: s0.headers,
      body: JSON.stringify({ oldPassword: initial, newPassword: next }),
    });
    assert.equal(changed.status, 204, `${username} password change failed`);
    const session = await login(username, next);
    assert.ok(session, `${username} relogin failed`);
    return session;
  };
  const op = await useAs('lineop', opPw, OPERATOR_PW);
  const vi = await useAs('watcher', viPw, VIEWER_PW);
  check('新建的用户可登录（首次强制改密后）', Boolean(op) && Boolean(vi));

  // ── 运维：授权范围内可用 ──
  const opList = await (await fetch(`${B}/api/instances`, { headers: op.headers })).json();
  check('运维只看得见被授权的实例',
        opList.instances?.length === 1 && opList.instances[0].id === 'line-a',
        (opList.instances ?? []).map((i) => i.id).join(' ') || '空');

  check('运维可查看授权实例', await status('/api/instances/line-a', op) === 200);
  check('运维可启停授权实例',
        await status('/api/instances/line-a/stop', op, { method: 'POST' }) === 204);

  // ── 越权：跨实例 ──
  check('越权·查看未授权实例被拒', await status('/api/instances/line-b', op) === 403);
  check('越权·启停未授权实例被拒',
        await status('/api/instances/line-b/stop', op, { method: 'POST' }) === 403);
  check('越权·读未授权实例日志被拒', await status('/api/instances/line-b/logs', op) === 403);
  check('越权·看未授权实例健康被拒', await status('/api/instances/line-b/health', op) === 403);

  // ── 越权：反代与免密跳转（最大的越权面）──
  upstreamHits = 0;
  check('越权·反代打开未授权实例编辑器被拒',
        await status('/red/line-b/', op) === 403);
  check('越权·免密跳转未授权实例被拒', await status('/red/line-b/sso', op) === 403);
  check('被拒时请求根本没打到上游', upstreamHits === 0, `上游被访问 ${upstreamHits} 次`);
  check('授权实例的反代仍然可用', await status('/red/line-a/', op) === 200);

  // ── 强制改密不能只靠前端路由 ──
  /*
   * 会话在改密前是**完全有效**的，只有 Vue 路由守卫在拦。
   * 拿着初始口令直接打后端接口就能绕过去 —— 而初始口令是无人值守装机时
   * INITIAL_PASSWORD 给的那一个，写在编排文件里，见过它的人比该有权限的人多。
   * 所以闸门必须在后端 guard 上，前端那层只是引导。
   */
  const pendPw = await mk('pending', 'admin');
  const pend = await login('pending', pendPw);
  check('待改密用户能登录（否则没法改密）', Boolean(pend));
  check('待改密·调业务接口被拒', await status('/api/instances', pend) === 403);
  check('待改密·管理员接口也被拒（角色再大也先改密）',
        await status('/api/users', pend) === 403);
  check('待改密·反代打开编辑器被拒（编辑器后面是实例 admin API）',
        await status('/red/line-a/', pend) === 403);
  const pendErr = await (await fetch(`${B}/api/instances`, { headers: pend.headers })).json();
  check('待改密·错误里带机器可识别的 code，前端据此跳改密页',
        pendErr.code === 'PASSWORD_CHANGE_REQUIRED', JSON.stringify(pendErr).slice(0, 70));
  // 改密通道本身必须留着，否则用户被锁死
  check('待改密·仍可读自己的会话（/api/me）', await status('/api/me', pend) === 200);
  const changed = await fetch(`${B}/api/change-password`, {
    method: 'POST', headers: pend.headers,
    body: JSON.stringify({ oldPassword: pendPw, newPassword: PENDING_PW }),
  });
  check('待改密·改密接口可用（不能把人锁死）', changed.status === 204, `HTTP ${changed.status}`);
  const afterPend = await login('pending', PENDING_PW);
  check('改密后恢复正常访问', await status('/api/instances', afterPend) === 200);
  /*
   * 用完降级。这个账号特意建成 admin，是为了证明「角色再大也得先改密」；
   * 但留着它系统里就有两个管理员，后面「最后一个管理员不能被停用」那条前提就没了 ——
   * 那条会拿到 204，再 .json() 空体直接抛 Unexpected end of JSON input。
   */
  await fetch(`${B}/api/users/pending/role`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ role: 'viewer' }),
  });

  // ── WebSocket 升级按写操作判 ──
  /*
   * 握手是 GET，但通道建起来就是双向的：实例的 httpNodeRoot 与编辑器同处
   * 一个反代前缀，流程里放个 `websocket in` 节点就能对外开端点，
   * 只读用户握手成功即可往流程灌消息。那是写，不是看。
   */
  // 使用真实 WebSocket 客户端并区分 HTTP 拒绝、成功升级、传输错误和超时。
  const upgradeStatus = (sess, options = {}) => new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/red/line-a/comms`, {
      headers: { cookie: sess.cookie, origin: B },
    });
    ws.on('open', async () => {
      if (options.waitForUpstream) {
        const deadline = Date.now() + 2000;
        while (upstreamUpgradeHits === 0 && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      ws.close();
      finish({ kind: 'upgrade', status: 101, upstreamConnected: upstreamUpgradeHits > 0 });
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish({ kind: 'http', status: response.statusCode ?? 0 });
    });
    ws.on('error', (error) => finish({ kind: 'transport', code: error.code ?? error.name }));
    ws.on('close', (code) => finish({ kind: 'closed', code }));
    timer = setTimeout(() => {
      ws.terminate();
      finish({ kind: 'timeout' });
    }, 4000);
  });

  upstreamUpgradeHits = 0;
  upstreamResolveHits = 0;
  const viUp = await upgradeStatus(vi);
  check('越权·只读用户建立实时通道被拒（该通道可向流程写入）',
    viUp.kind === 'http' && viUp.status === 403 && upstreamUpgradeHits === 0,
    viUp.kind === 'http' ? `HTTP ${viUp.status}` : viUp.kind);
  const opUp = await upgradeStatus(op, { waitForUpstream: true });
  check('可操作用户的实时通道通过了授权层（未被 403）',
    opUp.kind === 'upgrade' && opUp.status === 101
      && opUp.upstreamConnected === true && upstreamUpgradeHits === 1,
    `${opUp.kind}${opUp.status === undefined ? '' : ` HTTP ${opUp.status}`}`
      + `${opUp.code === undefined ? '' : ` ${opUp.code}`}`
      + ` · upstream resolutions ${upstreamResolveHits} · upgrades ${upstreamUpgradeHits}`);

  // ── 越权：角色级动作 ──
  check('越权·运维建实例被拒',
        await status('/api/instances', op, { method: 'POST', body: '{}' }) === 403);
  check('越权·运维删实例被拒',
        await status('/api/instances/line-a', op, { method: 'DELETE' }) === 403);
  check('越权·运维管用户被拒', await status('/api/users', op) === 403);
  check('越权·运维跑备份被拒（备份含全部实例凭据）',
        await status('/api/backup', op, { method: 'POST' }) === 403);

  // ── 只读角色 ──
  check('只读可查看授权实例', await status('/api/instances/line-a', vi) === 200);
  check('越权·只读启停被拒',
        await status('/api/instances/line-a/stop', vi, { method: 'POST' }) === 403);
  check('越权·只读重置实例口令被拒',
        await status('/api/instances/line-a/credentials/admin/reset', vi, { method: 'POST' }) === 403);
  check('越权·只读手动补传被拒',
        await status('/api/edge/replay', vi, { method: 'POST' }) === 403);

  // ── 越权：聚合类接口 ──
  // 这类接口天然没有「某一台实例」可判，漏了过滤就是把别人的实例名连同读数端出去
  const trend = await (await fetch(`${B}/api/metrics?range=1h`, { headers: op.headers })).json();
  const trendIds = Object.keys(trend.points?.[0]?.instances ?? {});
  check('越权·趋势曲线不含未授权实例', trend.instanceIds?.length === 1
        && trend.instanceIds[0] === 'line-a' && trendIds.join() === 'line-a',
        `ids=${(trend.instanceIds ?? []).join(' ')} points=${trendIds.join(' ')}`);
  check('趋势里的宿主读数照常返回（整机指标与实例授权无关）',
        typeof trend.points?.[0]?.host?.memPercent === 'number');

  const devs = await (await fetch(`${B}/api/field/devices`, { headers: op.headers })).json();
  check('越权·设备台账聚合查询只含授权实例',
        devs.devices?.length === 1 && devs.devices[0].instanceId === 'line-a',
        (devs.devices ?? []).map((d) => d.instanceId).join(' ') || '空');
  check('越权·指名查未授权实例的台账被拒',
        await status('/api/field/devices?instanceId=line-b', op) === 403);
  check('越权·指名查未授权实例的点位被拒',
        await status('/api/field/tags?instanceId=line-b', op) === 403);
  check('越权·南向探测未授权实例被拒（读的是 flows.json，含设备 IP 与寄存器地址）',
        await status('/api/field/southbound?instanceId=line-b', op) === 403);
  check('越权·未授权实例的台账汇总被拒',
        await status('/api/field/summary?instanceId=line-b', op) === 403);

  // ── 只读授权不是「能看的操作员」──
  upstreamHits = 0;
  check('只读授权可以打开编辑器查看', await status('/red/line-a/', vi) === 200);
  check('越权·只读授权经反代改流程被拒（POST /flows 是部署）',
        await status('/red/line-a/flows', vi, { method: 'POST', body: '[]' }) === 403);
  check('只读被拒时改动没有打到实例', upstreamHits === 1, `上游被访问 ${upstreamHits} 次（应只有那次 GET）`);

  // ── 越权：WebSocket 升级 ──
  // 浏览器不对 WS 施加同源策略，这条链路必须自己判权，且要在升级阶段就拒
  const wsCode = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/red/line-b/comms`,
                             { headers: { cookie: op.cookie, origin: B } });
    const done = (v) => { try { ws.terminate(); } catch { /* 已关 */ } resolve(v); };
    ws.on('unexpected-response', (_q, res) => done(res.statusCode));
    ws.on('open', () => done(101));
    ws.on('error', () => done(0));
    setTimeout(() => done(-1), 3000);
  });
  check('越权·未授权实例的 WebSocket 升级被拒', wsCode === 403, `升级返回 ${wsCode}`);

  // ── 撤销授权立即生效 ──
  await fetch(`${B}/api/users/lineop/grants/line-a`, { method: 'DELETE', headers: root.headers });
  check('撤销授权后立即失效，无需重新登录',
        await status('/api/instances/line-a', op) === 403);

  // ── 停用账号 ──
  await fetch(`${B}/api/users/watcher/disabled`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ disabled: true }),
  });
  check('停用后已有会话立即失效', await status('/api/instances', vi) === 401);
  check('停用后无法重新登录', (await login('watcher', VIEWER_PW)) === undefined);

  // ── 不能把自己锁在门外 ──
  const selfDisable = await fetch(`${B}/api/users/admin/disabled`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ disabled: true }),
  });
  check('最后一个管理员不能被停用', selfDisable.status === 400,
        `HTTP ${selfDisable.status} ${(await selfDisable.json()).error ?? ''}`.slice(0, 60));
  const selfDemote = await fetch(`${B}/api/users/admin/role`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ role: 'viewer' }),
  });
  check('最后一个管理员不能被降级', selfDemote.status === 400);

  // ── 重置口令必须当场踢掉旧会话 ──
  // 重置的场景往往是「凭据可能泄漏了」，旧会话还活着的话这个动作等于没做
  const tmpPw = await mk('shift-b', 'viewer');
  const tmp = await useAs('shift-b', tmpPw, SHIFT_PW);
  check('新账号登录后会话可用', await status('/api/instances', tmp) === 200);
  await fetch(`${B}/api/users/shift-b/password/reset`, { method: 'POST', headers: root.headers });
  check('管理员重置口令后，旧会话立即失效', await status('/api/instances', tmp) === 401);

  // ── 登录失败限速不能变成锁死管理员的按钮 ──
  for (let i = 0; i < 6; i += 1) await login('admin', WRONG_PW);
  check('同一来源连续失败会被锁定',
        (await (await fetch(`${B}/api/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: ADMIN_NEXT_PW }),
        })).json()).error?.includes('锁定') === true);

  // ── 未登录 ──
  check('未登录访问实例被拒', await status('/api/instances') === 401);
  check('未登录访问反代被拒', await status('/red/line-a/') === 401);

  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  if (pass !== results.length) process.exit(1);
}

main().catch(async (e) => {
  let cleanupError;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  console.error('\n  验证异常：', e.message,
    cleanupError ? `；清理失败：${cleanupError.message}` : '');
  process.exit(1);
});
