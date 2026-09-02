/**
 * 企业 HTTP 代理出网验证（T6.2 补齐 · `03-复杂网络环境适配.md` 2.10）。
 *
 * 现场形态：边缘盒子不能直接出网，所有对外 HTTP 必须经企业代理。
 * 这条链路有三段，**三段都得验**，只验一段的话另外两段坏了没人知道：
 *
 *   A. 安装自检能在装之前认出代理配错、不通、NO_PROXY 漏内部条目
 *   B. Manager 自己出网（升级检查）真的走代理，而不是绕过去直连
 *   C. 实例容器真的拿到了代理变量，且 NO_PROXY 里有内部条目
 *
 * C 段起真容器 —— 「透传给实例容器」这件事只有 docker inspect 能证明。
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Docker from 'dockerode';
import bcrypt from 'bcryptjs';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { renderSettings } from '../dist/core/instance/settings-template.js';
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
import { runPreflight } from '../dist/core/preflight/run.js';
import { proxyEnvFor } from '../dist/core/proxy.js';
import { TEST_DATA_ROOT, ensureRoot } from './_data-root.mjs';

const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-role';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const RUN_ID = `egress-${randomBytes(5).toString('hex')}`;
const ID = `e${randomBytes(5).toString('hex')}`;
const NET = `${RUN_ID}-net`;
const INSTANCE_NET = `${NET}-${ID}`;
const PROXY_NET = `${RUN_ID}-proxy-net`;
const PROXY_BOX = `${RUN_ID}-proxy`;
const OUTBOUND_BOX = `${RUN_ID}-outbound`;
const RUN_DATA_ROOT = `${TEST_DATA_ROOT}/${RUN_ID}`;
const DATA_OWNER = `${RUN_DATA_ROOT}/.verifier-owner`;
const TAG = '5.0.4-24-minimal';
/*
 * 假代理源码。**必须实现 CONNECT** ——
 * Node 的内置代理（undici ProxyAgent）即使目标是 http:// 也走 CONNECT 隧道，
 * 只处理普通请求的假代理会让客户端一直等，表现成「代理没收到请求 + 超时」，
 * 排查半天才发现是验证工具不对，不是产品不对。
 *
 * 这条同时是**现场事实**：只放行 443 CONNECT 的企业代理策略，会让升级检查失败。
 */
const FAKE_PROXY_SRC = `
const http = require('node:http');
const body = JSON.stringify({ tag_name: 'v9.9.9', html_url: 'http://example.invalid/r' });
const respond = (sock) => sock.write(
  'HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\n'
  + 'content-length: ' + Buffer.byteLength(body) + '\\r\\nconnection: close\\r\\n\\r\\n' + body);
const srv = http.createServer((q, r) => {
  console.log('HIT ' + q.method + ' ' + q.url);
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end(body);
});
srv.on('connect', (q, sock) => {
  console.log('HIT CONNECT ' + q.url);
  sock.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
  sock.once('data', () => respond(sock));
});
srv.listen(8080, '0.0.0.0', () => console.log('READY'));
`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const raw = new Docker();
let protectedBefore;
let hostProxy;
let runtimeDb;
const ownedContainerIds = new Map();
const ownedNetworkIds = new Map();

/** 跑一条命令并返回 stdout+stderr；失败即抛，避免「静默没跑」被当成通过 */
function sh(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 90_000 }, (err, stdout, stderr) => {
      if (err) rej(new Error(`${cmd} ${args.slice(0, 3).join(' ')}：${stderr || err.message}`));
      else res(`${stdout}${stderr}`);
    });
  });
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
  // This proxy propagation scenario uses a pre-seeded legacy fixture. Keep the
  // actual package service fail-closed instead of fabricating trusted tarballs.
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
    basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: [TAG], probeHostPorts: false,
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
  await attempt('host proxy close', () => new Promise((resolve, reject) => {
    if (!hostProxy?.listening) return resolve();
    const server = hostProxy;
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of server.verifierSockets ?? []) socket.destroy();
  }));
  hostProxy = undefined;
  await attempt('database close', async () => {
    if (runtimeDb?.open) runtimeDb.close();
    runtimeDb = undefined;
  });
  for (const [name, role] of [[OUTBOUND_BOX, 'outbound'], [PROXY_BOX, 'proxy']]) {
    await attempt(`${role} cleanup`, () => removeExactContainer(name, (info) => {
      assert.equal(info.Config?.Labels?.[RUN_LABEL], RUN_ID);
      assert.equal(info.Config?.Labels?.[ROLE_LABEL], role);
    }));
  }
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
  await attempt('proxy network cleanup', () => removeExactNetwork(PROXY_NET, (info) => {
    assert.equal(info.Labels?.[RUN_LABEL], RUN_ID);
    assert.equal(info.Labels?.[ROLE_LABEL], 'proxy-network');
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

/** 假代理：只记录「谁来找过我、要去哪」，不真的转发 */
function fakeProxy() {
  const seen = [];
  const body = JSON.stringify({ tag_name: 'v9.9.9', html_url: 'http://example.invalid/r' });
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  // CONNECT 隧道：Node 的内置代理即使目标是 http:// 也走这条路，见 FAKE_PROXY_SRC 的说明
  srv.on('connect', (req, sock) => {
    seen.push(`CONNECT ${req.url}`);
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    sock.once('data', () => sock.write(
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`));
  });
  const sockets = new Set();
  srv.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  srv.verifierSockets = sockets;
  return { srv, seen };
}

const internal = {
  managerContainer: `${RUN_ID}-manager`, instancePrefix: 'tle-nr-', network: NET,
};

async function main() {
  console.log('\n──── 企业 HTTP 代理出网 · 验证 ────\n');
  protectedBefore = await protectedSnapshot();
  await ensureRoot();
  await reserveRunDataRoot();

  const { srv } = fakeProxy();
  hostProxy = srv;
  /*
   * 监听全部网卡而不是只回环：C 段要让**容器**回连这个假代理，
   * 而容器走的是 host-gateway 那个地址，只绑 127.0.0.1 的话它连不进来
   * （表现正是「代理收到 0 个请求」加超时）。端口是临时随机口，用完即关。
   */
  await new Promise((r) => srv.listen(0, r));
  const proxyPort = srv.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  // ── A. 安装自检 ────────────────────────────────────────
  const preflightWith = (proxy, cloudConfigured = false) => runPreflight({
    externalUrl: 'http://127.0.0.1:1', listenAddr: '127.0.0.1', listenPort: 13399,
    dataDir: '/tmp', portRange: { min: 30000, max: 30999 }, images: [],
    corporateCidrs: [], ntpServer: '', proxy, internalHosts: internal, cloudConfigured,
    hostStats: async () => ({ diskTotalGb: 100, diskUsedGb: 10, diskPercent: 10 }),
    timeoutMs: 1500,
  }).then((r) => r.checks.find((c) => c.id === 'network.proxy'));

  const offline = await preflightWith({ httpProxy: '', httpsProxy: '', noProxy: '' });
  check('未配代理时自检跳过而不是报错（离线部署是常态）', offline?.status === 'skip', offline?.detail?.slice(0, 40));

  const bad = await preflightWith({ httpProxy: 'proxy.corp:8080', httpsProxy: '', noProxy: '' });
  check('代理地址写错当场阻断安装', bad?.status === 'fail' && bad?.severity === 'block');

  const dead = await preflightWith({ httpProxy: 'http://127.0.0.1:9', httpsProxy: '', noProxy: '' });
  check('代理不通当场阻断（否则现场表现是所有请求卡到超时）',
        dead?.status === 'fail' && dead?.severity === 'block');

  const missing = await preflightWith({ httpProxy: proxyUrl, httpsProxy: '', noProxy: '' });
  check('NO_PROXY 漏内部条目给出告警并点名',
        missing?.severity === 'warn' && missing.detail.includes(internal.managerContainer),
        missing?.detail?.slice(0, 60));

  const full = `localhost,${internal.managerContainer},${internal.instancePrefix},${NET}`;
  // 回环地址会（正确地）触发「容器里的 127.0.0.1 指向容器自己」那条告警，
  // 所以验 pass 要用非回环地址 —— 假代理已监听全部网卡
  const lanIp = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const good = await preflightWith(
    { httpProxy: `http://${lanIp ?? '127.0.0.1'}:${proxyPort}`, httpsProxy: '', noProxy: full });
  check('代理可达且 NO_PROXY 齐全时通过', lanIp ? good?.status === 'pass' : true,
        lanIp ? good?.detail?.slice(0, 60) : '本机无非回环地址，跳过');

  const loop = await preflightWith({ httpProxy: proxyUrl, httpsProxy: '', noProxy: full });
  check('回环地址的代理会被点出来（容器里的 127.0.0.1 是容器自己）',
        loop?.data?.loopbackProxy === true && loop?.severity === 'warn');

  const withCloud = await preflightWith({ httpProxy: proxyUrl, httpsProxy: '', noProxy: full }, true);
  check('配了云连接会明说「MQTT 不走 HTTP 代理」', withCloud?.detail?.includes('MQTT') === true);

  /*
   * ── B. Manager 自己出网走代理 ──────────────────────────
   *
   * 必须在**产品镜像里**验，不能在宿主上验：
   *   · `NODE_USE_ENV_PROXY` 是启动期开关，镜像 ENV 里开着才算数 ——
   *     在宿主上加 `--use-env-proxy` 只能证明「Node 有这个能力」，
   *     证明不了「我们发出去的那个镜像开了它」
   *   · 宿主 Node 版本未必与镜像一致（实测宿主 v22 上该开关行为就不同）
   *
   * 假代理也起成容器、与被测镜像同处一张 docker 网络：容器回连宿主这条路
   * 在不少机器上被防火墙或 Docker Desktop 挡着（实测本机就不通），
   * 那样跑出来的失败是环境问题，不是产品问题，最会误导人。
   *
   * 断言取巧但严密：目标域名 `update.invalid` **不可能解析**，
   * 所以只要响应体里出现假代理返回的版本号，就只能是经代理拿到的。
   */
  const image = process.env.MANAGER_IMAGE ?? 'mqttsnet/thinglinks-edge:1.0.1';
  const hasImage = await raw.getImage(image).inspect().then((i) => i, () => undefined);
  if (!hasImage) {
    check(`本机没有 ${image}，镜像内验证无法进行`, false,
          '先 docker compose -f docker-compose.yml -f docker-compose.build.yml build');
    throw new Error(`required Manager image is missing: ${image}`);
  } else {
    assert.match(hasImage.Id, /^sha256:[a-f0-9]{64}$/);
    const imageId = hasImage.Id;
    const imgEnv = hasImage.Config?.Env ?? [];
    check('镜像里默认打开了 NODE_USE_ENV_PROXY（没开则代理配了也不生效）',
          imgEnv.includes('NODE_USE_ENV_PROXY=1'),
          imgEnv.filter((e) => e.startsWith('NODE_')).join(' ') || '(无)');

    const proxyNetwork = await raw.createNetwork({
      Name: PROXY_NET, Internal: true,
      Labels: { [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'proxy-network' },
    });
    const proxyNetworkInfo = await proxyNetwork.inspect();
    assert.equal(proxyNetworkInfo.Labels?.[RUN_LABEL], RUN_ID);
    ownedNetworkIds.set(PROXY_NET, proxyNetworkInfo.Id);
    await sh('docker', [
      'run', '-d', '--name', PROXY_BOX, '--network', PROXY_NET,
      '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${ROLE_LABEL}=proxy`,
      '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
      '--entrypoint', 'node', 'node:24.19.0-alpine', '-e', FAKE_PROXY_SRC,
    ]);
    const proxyInfo = await raw.getContainer(PROXY_BOX).inspect();
    assert.equal(proxyInfo.Config?.Labels?.[RUN_LABEL], RUN_ID);
    ownedContainerIds.set(PROXY_BOX, proxyInfo.Id);
    // 等它把端口听起来，否则第一次请求会连接被拒
    let proxyReady = false;
    for (let i = 0; i < 40; i += 1) {
      const logs = await sh('docker', ['logs', PROXY_BOX]).catch(() => '');
      if (logs.includes('READY')) { proxyReady = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(proxyReady, true, 'container proxy did not become ready');

    const out = await sh('docker', [
      'run', '--name', OUTBOUND_BOX, '--network', PROXY_NET,
      '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${ROLE_LABEL}=outbound`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
      '-e', `HTTP_PROXY=http://${PROXY_BOX}:8080`,
      '--entrypoint', 'node', imageId, '-e',
      "fetch('http://update.invalid/latest', { signal: AbortSignal.timeout(8000) })"
      + '.then((r) => r.text()).then((t) => console.log(t))'
      + ".catch((e) => console.log('ERR', e.name, e.cause?.code ?? ''))"
      // 显式退出：fetch 用的连接池会保持 keep-alive 套接字，
      // 不退的话容器会一直挂着，表现成「验证卡住」而不是「请求失败」
      + '.finally(() => process.exit(0));',
    ]);
    const outboundInfo = await raw.getContainer(OUTBOUND_BOX).inspect();
    assert.equal(outboundInfo.Config?.Labels?.[RUN_LABEL], RUN_ID);
    ownedContainerIds.set(OUTBOUND_BOX, outboundInfo.Id);

    const proxyLog = await sh('docker', ['logs', PROXY_BOX]).catch(() => '');
    check('镜像里的对外请求确实打到了代理，而不是绕过去直连',
          proxyLog.includes('HIT'), `代理日志：${proxyLog.trim().split('\n').pop() ?? '(空)'}`);
    check('经代理拿回来的响应体完好（域名不可解析，能拿到就只能来自代理）',
          out.includes('9.9.9'), out.trim().slice(0, 70));
    check('走的是 CONNECT 隧道 —— 只放行 443 CONNECT 的代理策略会挡掉升级检查',
          proxyLog.includes('HIT CONNECT'),
          proxyLog.trim().split('\n').filter((l) => l.startsWith('HIT')).join(' | ').slice(0, 70));
  }

  // ── C. 实例容器拿到代理变量 ────────────────────────────
  const runtimeRoot = join(RUN_DATA_ROOT, 'manager');
  await mkdir(runtimeRoot, { mode: 0o700 });
  const db = openDb(join(runtimeRoot, 'edge.db'));
  runtimeDb = db;
  const repo = new InstanceRepo(db, deriveKey('proxy', 'salt'));
  const proxyEnv = proxyEnvFor({ httpProxy: proxyUrl, httpsProxy: '', noProxy: '10.0.0.0/8' }, internal);
  const instanceNetwork = await raw.createNetwork({
    Name: INSTANCE_NET, Driver: 'bridge', Internal: true,
    Labels: {
      [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
      [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'instance-network',
    },
  });
  const instanceNetworkInfo = await instanceNetwork.inspect();
  assert.equal(instanceNetworkInfo.Id, instanceNetwork.id);
  assert.equal(instanceNetworkInfo.Internal, true);
  assert.equal(instanceNetworkInfo.Labels?.[RUN_LABEL], RUN_ID);
  ownedNetworkIds.set(INSTANCE_NET, instanceNetworkInfo.Id);
  const docker = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: RUN_DATA_ROOT,
    timezone: 'Asia/Shanghai', proxyEnv,
  });
  const upstreamFor = (instanceId) => `http://${containerName(instanceId)}:1880`;
  const runtime = assembleRuntime({
    db, repo, docker, dataRoot: runtimeRoot, upstreamFor,
  });
  repo.create(
    {
      id: ID, name: '代理验证', imageTag: TAG, memLimit: 256, cpuLimit: 0.5,
      adminRoot: `/red/${ID}/`, credSecret: 'proxy-credential-secret', notes: '',
      nodeRuntimeMode: 'legacy',
    },
    [],
    [{ username: 'admin', password: 'proxy-node-red-password', permissions: '*' }],
  );
  await docker.createInstance({
    id: ID, imageTag: TAG, memoryMb: 256, cpus: 0.5, ports: [],
    adminRoot: `/red/${ID}/`,
  }, renderSettings({
    instanceId: ID, nodeRuntimeMode: 'legacy', adminRoot: `/red/${ID}/`,
    credentialSecret: 'proxy-credential-secret',
    credentials: [{
      username: 'admin', passwordHash: bcrypt.hashSync('proxy-node-red-password', 8), permissions: '*',
    }],
  }), 'legacy');
  const instanceInfo = await raw.getContainer(containerName(ID)).inspect();
  assert.equal(instanceInfo.Config?.Labels?.[MANAGED_LABEL], 'true');
  assert.equal(instanceInfo.Config?.Labels?.[INSTANCE_LABEL], ID);
  ownedContainerIds.set(containerName(ID), instanceInfo.Id);
  await runtime.service.start(ID, 'verify');

  const info = await raw.getContainer(containerName(ID)).inspect();
  const env = Object.fromEntries(
    (info.Config?.Env ?? []).map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }),
  );
  check('实例容器拿到了 HTTP_PROXY', env['HTTP_PROXY'] === proxyUrl, env['HTTP_PROXY']);
  check('大小写各给一份（容器里的程序读哪种全看实现）', env['http_proxy'] === proxyUrl);
  check('只配 HTTP_PROXY 时 HTTPS 也回落到它，不会绕过代理直连',
        env['HTTPS_PROXY'] === proxyUrl);
  const noProxy = (env['NO_PROXY'] ?? '').split(',');
  check('NO_PROXY 保留了部署方填的内网段', noProxy.includes('10.0.0.0/8'), env['NO_PROXY']);
  check('NO_PROXY 补齐了内部条目 —— 漏了它容器间通信会被绕去代理',
        ['localhost', '127.0.0.1', internal.managerContainer, 'tle-nr-', NET]
          .every((v) => noProxy.includes(v)),
        env['NO_PROXY']);
  await runtime.service.stop(ID, 'verify');

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
