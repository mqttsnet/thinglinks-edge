/**
 * 节点管理端到端验证（01 号文 5.7）—— 对着**一台真实 Node-RED 容器**跑。
 *
 * 为什么必须用真容器：这一整套的正确性完全取决于 Node-RED 5.0.4 的实际行为，
 * 而它的白名单语义与文档给人的印象相反（见 core/nodes/policy.ts 的文件头）。
 * 上一版实现就是照着直觉配的，配出来一个**看着生效、其实全放行**的白名单。
 * 拿假的 Admin API 测，只会把同样的误解再确认一遍。
 *
 * ## 离线证明怎么做的
 *
 * 夹具包用的是**公网 npm 上不存在**的名字（node-red-contrib-tle-fixture-*）。
 * 它要是能装上，就只可能来自我们自己的私有源 —— 不需要去断容器的网，
 * 也就不存在「到底断没断干净」的争议。
 *
 * ## 拓扑
 *
 * Manager 跑在宿主上，实例在 docker 网络里，两个方向都要搭桥：
 *
 *   宿主 → 实例：socat 边车（与 verify-template 同款，因为 1880 禁止映射宿主）
 *   实例 → 宿主：socat 边车 + host.docker.internal:host-gateway
 *                （容器里的 npm 要访问 Manager 上的私有源）
 *
 * 生产里 Manager 与实例同处一网、直接按容器名解析，没有这两层。
 */
import Docker from 'dockerode';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import {
  InstanceOperationGate,
  InstanceRepositoryOperationPolicy,
} from '../dist/core/instance/operation-gate.js';
import { ProxySessionRegistry } from '../dist/core/instance/proxy-session-registry.js';
import { buildServer } from '../dist/http/app.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { NodeStore } from '../dist/core/nodes/store.js';
import { NodeCatalog } from '../dist/core/nodes/catalog.js';
import { buildPolicy } from '../dist/core/nodes/policy.js';
import { UpstreamRegistry } from '../dist/core/nodes/upstream.js';
import { MigrationCheckpointStore } from '../dist/core/nodes/migration-checkpoint.js';
import {
  NodeRedPlatformMigrationAdminActions,
  PlatformMigrationService,
} from '../dist/core/nodes/platform-migration.js';
import {
  PLATFORM_APPROVAL_NOTE,
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from '../dist/core/nodes/platform-contract.js';
import {
  assembleInstanceAdminRuntime,
  assemblePlatformNodeServices,
  assemblePlatformOperationBarrier,
} from '../dist/index.js';
import { tarArchive } from '../dist/core/archive/tar.js';
import {
  TEST_DATA_ROOT,
  TEST_EDGE_ROOT,
  dataDirExists,
  ensureRoot,
  resetDataDir,
} from './_data-root.mjs';
import { adminSession } from './_session.mjs';

const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 12);
const NET = `tle-nodes-net-${RUN_ID}`;
const BRIDGE_IN = `tle-nodes-bridge-in-${RUN_ID}`;  // 宿主 → 实例
const BRIDGE_OUT = `tle-nodes-bridge-out-${RUN_ID}`; // 实例 → 宿主（私有源）
const REG_PORT = 19100;
const ADMIN_PW = 'initial-password-123';
const ID = `nodes-${RUN_ID}`;
const TAG = '5.0.4-24-minimal';
const PUBLIC_CATALOGUE_URL = 'https://catalogue.nodered.org/catalogue.json';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const VERIFY_RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verify-run';
const VERIFY_ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verify-role';
const NETWORK_NAME = `${NET}-${ID}`;

let PORT;
let NR_PORT;
let UPSTREAM_PORT;

/** 批准的夹具 —— 公网上不存在这个名字 */
const OK_PKG = 'node-red-contrib-tle-fixture-ok';
/** 库里有、但**没批准**的夹具 —— 用来隔离出「白名单」这一个变量 */
const DENIED_PKG = 'node-red-contrib-tle-fixture-denied';
/** 批准了、但**不放进库**的夹具 —— 用来验回源下载 */
const UPSTREAM_PKG = 'node-red-contrib-tle-fixture-upstream';
/**
 * 依赖被写成 **tarball URL** 的夹具（对着 node-red-contrib-modbus 5.60.2 实测后加的）。
 *
 * 真实的 modbus 把 @openp4nr/modbus-serial 声明成一个 cloudsmith 的 URL，
 * 那种声明**根本不经过 registry** —— npm 会直接去连那个域名，私有源被完全绕开，
 * 离线现场报 ECONNRESET，而报错里看不出「源里其实有这个包」。
 * 修法是生成 packument 时把非注册表声明改写成库里真实存在的版本
 * （core/nodes/packument.ts 的 resolveDeps）。这里验它在**真 npm** 上确实生效。
 */
const URLDEP_PKG = 'node-red-contrib-tle-fixture-urldep';
const URLDEP_LIB = 'tle-fixture-urldep-lib';
const GENERIC_FIXTURE_PACKAGES = Object.freeze([
  OK_PKG,
  DENIED_PKG,
  UPSTREAM_PKG,
  URLDEP_PKG,
  URLDEP_LIB,
]);
/** 容器里解析不了的主机名：npm 一旦去连它就必然失败 —— 这正是我们要的 */
const UNREACHABLE = `https://tle-nodes-verify.invalid/${URLDEP_LIB}-1.0.0.tgz`;

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const requireCheck = (name, ok, detail = '') => {
  check(name, ok, detail);
  if (!ok) throw new Error(`前置条件失败：${name}${detail ? `（${detail}）` : ''}`);
};
const cataloguesFromSettings = (settings) => {
  const match = /^\s*catalogues:\s*(\[[^\r\n]*\])/m.exec(settings);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const containerState = async (id) =>
  raw.getContainer(containerName(id)).inspect().then((i) => i.State.Status).catch(() => 'missing');

const allocatePort = () => new Promise((resolvePort, reject) => {
  const listener = createTcpServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    if (!address || typeof address === 'string') {
      listener.close();
      reject(new Error('无法分配验证端口'));
      return;
    }
    listener.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const sidecarLabels = (role) => ({
  [VERIFY_RUN_LABEL]: RUN_ID,
  [VERIFY_ROLE_LABEL]: role,
});

const containerOwnership = (name) => name === containerName(ID)
  ? { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID }
  : name === BRIDGE_IN ? sidecarLabels('bridge-in') : sidecarLabels('bridge-out');

const exactContainer = async (name) => {
  const info = await raw.getContainer(name).inspect().catch((error) => {
    if (error?.statusCode === 404) return undefined;
    throw error;
  });
  if (!info) return undefined;
  const expected = containerOwnership(name);
  const labels = info.Config?.Labels ?? {};
  if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
    throw new Error(`拒绝操作归属不匹配的容器 ${name}`);
  }
  return { id: info.Id, name };
};

const exactNetwork = async () => {
  const info = await raw.getNetwork(NETWORK_NAME).inspect().catch((error) => {
    if (error?.statusCode === 404) return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (
    info.Name !== NETWORK_NAME
    || info.Labels?.[MANAGED_LABEL] !== 'true'
    || info.Labels?.[INSTANCE_LABEL] !== ID
  ) throw new Error(`拒绝操作归属不匹配的网络 ${NETWORK_NAME}`);
  return { id: info.Id, name: info.Name };
};

async function createOwnedSidecar(options, role) {
  const container = await raw.createContainer({
    ...options,
    Labels: sidecarLabels(role),
  });
  const info = await container.inspect();
  const expectedName = role === 'bridge-in' ? BRIDGE_IN : BRIDGE_OUT;
  if (info.Name !== `/${expectedName}` || info.Id !== container.id) {
    throw new Error(`边车身份不一致：${expectedName}`);
  }
  const labels = info.Config?.Labels ?? {};
  if (Object.entries(sidecarLabels(role)).some(([key, value]) => labels[key] !== value)) {
    throw new Error(`边车归属标签不一致：${expectedName}`);
  }
  await raw.getContainer(info.Id).start();
}

async function createBootstrapBridges(docker) {
  const network = await exactNetwork();
  const instance = await exactContainer(containerName(ID));
  if (!network || !instance) throw new Error('bootstrap 容器或实例网络尚未形成');

  await createOwnedSidecar({
    name: BRIDGE_IN,
    Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${NR_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    ExposedPorts: { [`${NR_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      PortBindings: { [`${NR_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(NR_PORT) }] },
    },
  }, 'bridge-in');
  await createOwnedSidecar({
    name: BRIDGE_OUT,
    Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${REG_PORT},fork,reuseaddr`, `TCP:host.docker.internal:${PORT}`],
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
  }, 'bridge-out');
}

function cleanupGenericFixtures(store) {
  for (const name of GENERIC_FIXTURE_PACKAGES) {
    for (const version of store.versions(name)) store.remove(name, version);
  }
}

async function assertTargetsAbsent() {
  for (const name of [BRIDGE_IN, BRIDGE_OUT, containerName(ID)]) {
    const existing = await raw.getContainer(name).inspect().catch((error) => {
      if (error?.statusCode === 404) return undefined;
      throw error;
    });
    if (existing) throw new Error(`随机验证容器名已存在，拒绝启动：${name}`);
  }
  const network = await raw.getNetwork(NETWORK_NAME).inspect().catch((error) => {
    if (error?.statusCode === 404) return undefined;
    throw error;
  });
  if (network) throw new Error(`随机验证网络名已存在，拒绝启动：${NETWORK_NAME}`);
}

/** 造一个能被 Node-RED 真正加载起来的最小节点包 */
function fixture(name, version = '1.0.0', deps = undefined) {
  const type = name.replace('node-red-contrib-', '');
  const js = `module.exports = function (RED) {
  function TleFixture(config) { RED.nodes.createNode(this, config); }
  RED.nodes.registerType(${JSON.stringify(type)}, TleFixture);
};
`;
  const html = `<script type="text/javascript">
  RED.nodes.registerType(${JSON.stringify(type)}, {
    category: 'function', color: '#a6bbcf', defaults: { name: { value: '' } },
    inputs: 1, outputs: 1, icon: 'file.png', label: function () { return this.name || ${JSON.stringify(type)}; }
  });
</script>
<script type="text/html" data-template-name=${JSON.stringify(type)}>
  <div class="form-row"><label for="node-input-name">Name</label>
  <input type="text" id="node-input-name"></div>
</script>
`;
  return gzipSync(tarArchive([
    {
      name: 'package/package.json',
      content: JSON.stringify({
        name, version, description: `ThingLinks Edge 验证夹具 ${name}`,
        keywords: ['node-red', 'thinglinks'], license: 'MIT',
        'node-red': { nodes: { [type]: 'fixture.js' } },
        ...(deps ? { dependencies: deps } : {}),
      }),
    },
    { name: 'package/fixture.js', content: js },
    { name: 'package/fixture.html', content: html },
  ]));
}

/** 一个普通 npm 库（不是节点包）—— 给 URL 依赖夹具当被依赖方 */
function plainLib(name, version = '1.0.0') {
  return gzipSync(tarArchive([
    {
      name: 'package/package.json',
      content: JSON.stringify({ name, version, description: '验证夹具依赖', main: 'index.js' }),
    },
    { name: 'package/index.js', content: 'module.exports = 1;\n' },
  ]));
}

/**
 * 读容器里的一个文件。
 *
 * `Tty: true` 不能省：不开的话 docker 走多路复用流，每个数据块前面带 8 字节帧头，
 * 帧头会落在文本中间，把要比对的字符串切断 —— 表现是断言随机失败，
 * 而且越靠文件末尾的内容越容易中招。
 */
async function execInContainer(id, cmd) {
  let out = '';
  try {
    const exec = await raw.getContainer(containerName(id)).exec({
      Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true,
    });
    const stream = await exec.start({ hijack: true });
    await new Promise((resolve) => {
      stream.on('data', (c) => { out += c.toString('utf8'); });
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
  } catch { /* 容器没了就返回空串，由断言如实失败 */ }
  return out;
}

const catInContainer = (id, file) => execInContainer(id, ['cat', file]);

async function cleanup() {
  const failures = [];
  for (const name of [BRIDGE_IN, BRIDGE_OUT, containerName(ID)]) {
    try {
      const owned = await exactContainer(name);
      if (owned) await raw.getContainer(owned.id).remove({ force: true });
    } catch (error) {
      failures.push(error.message);
    }
  }
  try {
    const owned = await exactNetwork();
    if (owned) await raw.getNetwork(owned.id).remove();
  } catch (error) {
    failures.push(error.message);
  }
  await resetDataDir(ID);
  for (const name of [BRIDGE_IN, BRIDGE_OUT, containerName(ID)]) {
    const residual = await raw.getContainer(name).inspect().then(() => true).catch(() => false);
    if (residual) failures.push(`容器残留 ${name}`);
  }
  const networkResidual = await raw.getNetwork(NETWORK_NAME).inspect()
    .then(() => true).catch(() => false);
  if (networkResidual) failures.push(`网络残留 ${NETWORK_NAME}`);
  if (await dataDirExists(ID)) failures.push(`实例数据残留 ${ID}`);
  return failures;
}

/**
 * 一个只服务单个夹具包的假 registry。
 *
 * 不打公网：验证不该依赖外网，而且用真实公网包会让「到底走没走回源」变得说不清
 * —— 公网上存在的包，装成功了也可能是别处来的。假上游 + 公网不存在的包名，
 * 装成功就只可能是回源拿到的。
 */
function startFakeUpstream(body) {
  const sri = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const srv = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === `/${encodeURIComponent(UPSTREAM_PKG)}` || url === `/${UPSTREAM_PKG}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: UPSTREAM_PKG,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': {
          name: UPSTREAM_PKG, version: '1.0.0',
          dist: { tarball: `http://127.0.0.1:${UPSTREAM_PORT}/tgz`, integrity: sri },
        } },
      }));
      return;
    }
    if (url.startsWith('/-/v1/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ objects: [{ package: {
        name: UPSTREAM_PKG, version: '1.0.0', description: '回源验证夹具',
        keywords: ['node-red'], date: '2026-08-31T00:00:00.000Z',
      } }] }));
      return;
    }
    if (url === '/tgz') { res.writeHead(200); res.end(body); return; }
    res.writeHead(404); res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => srv.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(srv)));
}

let server;
let upstreamServer;
let nodeStore;
let protectedDigests;
async function main() {
  [PORT, NR_PORT, UPSTREAM_PORT] = await Promise.all([
    allocatePort(), allocatePort(), allocatePort(),
  ]);
  await assertTargetsAbsent();
  await resetDataDir(ID);
  await ensureRoot();

  const dataDir = `${TEST_EDGE_ROOT}/manager`;
  const db = openDb(':memory:');
  const key = deriveKey('verify', 'salt');
  const repo = new InstanceRepo(db, key);
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);

  // 复用真实 <dataDir>/npm；只清本脚本的普通夹具，固定 Edge/common 根绝不删改。
  const store = new NodeStore(`${dataDir}/npm`);
  nodeStore = store;
  cleanupGenericFixtures(store);
  const catalog = new NodeCatalog(db);
  const platformNodeServices = assemblePlatformNodeServices({ store, catalog });
  const trusted = platformNodeServices.platformPackages.verifyForInstall();
  const trustedCommon = platformNodeServices.platformPackages.snapshotForRegistry(
    PLATFORM_COMMON_PACKAGE.name,
    PLATFORM_COMMON_PACKAGE.version,
  );
  if (!trustedCommon) throw new Error('固定 common 信任根不可用');
  protectedDigests = new Map([
    [PLATFORM_NODE_PACKAGE.name, createHash('sha256').update(trusted.buffer).digest('hex')],
    [PLATFORM_COMMON_PACKAGE.name, createHash('sha256').update(trustedCommon.buffer).digest('hex')],
  ]);
  requireCheck('固定 Edge/common 信任根存在且完整性匹配',
    trusted.meta.name === PLATFORM_NODE_PACKAGE.name
      && trusted.meta.version === PLATFORM_NODE_PACKAGE.version
      && trusted.meta.integrity === PLATFORM_NODE_PACKAGE.integrity
      && trustedCommon.meta.name === PLATFORM_COMMON_PACKAGE.name
      && trustedCommon.meta.version === PLATFORM_COMMON_PACKAGE.version
      && trustedCommon.meta.integrity === PLATFORM_COMMON_PACKAGE.integrity);
  requireCheck('固定 Edge 被精确批准且 common 从不单独批准',
    catalog.get(PLATFORM_NODE_PACKAGE.name)?.version === PLATFORM_NODE_PACKAGE.version
      && catalog.get(PLATFORM_NODE_PACKAGE.name)?.note === PLATFORM_APPROVAL_NOTE
      && catalog.get(PLATFORM_COMMON_PACKAGE.name) === undefined);
  requireCheck('Edge 精确依赖 common，common 不是 Node-RED 节点包',
    trusted.meta.dependencies[PLATFORM_COMMON_PACKAGE.name] === PLATFORM_COMMON_PACKAGE.version
      && trustedCommon.meta.hasNodeRedMetadata === false);
  let paletteMode = 'allowlist';

  const docker = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 },
    instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
    // 实例里的 npm 通过出向边车访问宿主上的 Manager
    npmRegistry: `http://${BRIDGE_OUT}:${REG_PORT}/npm/`,
    managerUrl: `http://${BRIDGE_OUT}:${REG_PORT}`,
  });
  let bootstrapBridgesReady = false;
  const platformOperation = assemblePlatformOperationBarrier({
    barrier: {
      async reach(event) {
        if (
          event.instanceId === ID
          && event.phase === 'preparing'
          && event.boundary === 'after-container-create'
        ) {
          await createBootstrapBridges(docker);
          bootstrapBridgesReady = true;
        }
      },
    },
  });
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const proxySessions = new ProxySessionRegistry();
  const instanceAdmin = assembleInstanceAdminRuntime({
    repo,
    upstreamFor: () => `http://127.0.0.1:${NR_PORT}`,
  });
  let migrationService;
  const pendingStartCompletion = {
    completePendingStartUnderLease(instanceId, lease, actor) {
      if (!migrationService) throw new Error('迁移服务尚未装配');
      return migrationService.completePendingStartUnderLease(instanceId, lease, actor);
    },
  };
  const service = new InstanceService({
    ...instanceAdmin.instanceServiceDeps,
    ...platformOperation.instanceServiceDeps,
    db, repo, docker, gate: operationGate,
    instanceDataRoot: TEST_DATA_ROOT,
    platformPackages: platformNodeServices.platformPackages,
    pendingStartCompletion,
    basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: [TAG],
    probeHostPorts: false,
    // macOS 沙箱可能拒绝 uv_uptime；这里只隔离宿主读数，不替代 Docker/npm/Admin 行为。
    readHostStats: async () => ({
      cpuCount: 4,
      loadPercent: 1,
      memTotalMb: 4096,
      memUsedMb: 512,
      memPercent: 12.5,
      memReliable: true,
      diskTotalGb: 100,
      diskUsedGb: 10,
      diskPercent: 10,
      uptimeSec: 100,
    }),
    palettePolicy: () => buildPolicy(catalog.approved(), {
      allowInstall: true, catalogueUrl: '/npm/-/catalogue.json',
      publicCatalogueUrl: PUBLIC_CATALOGUE_URL,
      mode: paletteMode,
    }),
  });
  migrationService = new PlatformMigrationService({
    repo,
    gate: operationGate,
    proxySessions,
    docker,
    adminRuntime: instanceAdmin.adminRuntime,
    admin: new NodeRedPlatformMigrationAdminActions(instanceAdmin.adminRuntime),
    platformPackages: platformNodeServices.platformPackages,
    checkpoint: new MigrationCheckpointStore(TEST_DATA_ROOT),
    settings: service,
    repair: service,
    bootstrapRecovery: service,
    ...platformOperation.migrationServiceDeps,
    instanceDataRoot: TEST_DATA_ROOT,
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
    dataDir, dataRoot: TEST_EDGE_ROOT, instanceDataRoot: TEST_DATA_ROOT,
    portRange: { min: 30000, max: 30999 }, timezone: 'Asia/Shanghai', updateCheckUrl: '',
  };

  upstreamServer = await startFakeUpstream(fixture(UPSTREAM_PKG));
  const app = buildServer({
    ...instanceAdmin.serverDeps,
    ...platformNodeServices.serverDeps,
    config, db, auth, repo, service,
    operationGate,
    migrationService,
    proxySessions,
    upstreamFor: () => `http://127.0.0.1:${NR_PORT}`,
    nodeStore: store, nodeCatalog: catalog,
    npmRegistryUrl: `http://${BRIDGE_OUT}:${REG_PORT}/npm/`,
    nodeUpstream: new UpstreamRegistry({
      sources: () => [{ name: '假上游', url: `http://127.0.0.1:${UPSTREAM_PORT}` }],
    }),
  });
  /*
   * 监听 0.0.0.0 而不是 127.0.0.1：出向边车要从容器里连进来。
   * **这是验证脚手架的妥协**，生产默认只绑回环（见 config.listenAddr）。
   */
  await app.listen({ host: '0.0.0.0', port: PORT });
  server = app;
  const B = `http://127.0.0.1:${PORT}`;
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  const admin = await adminSession(B, ADMIN_PW);
  requireCheck('管理员登录成功', Boolean(admin.csrf));

  // ── 1. 往私有源导入两个夹具包 ─────────────────────
  for (const name of [OK_PKG, DENIED_PKG]) {
    const res = await fetch(`${B}/api/nodes/store`, {
      method: 'POST',
      headers: { ...H(admin), 'content-type': 'application/octet-stream' },
      body: fixture(name),
    });
    const body = await res.json().catch(() => ({}));
    requireCheck(`导入节点包 ${name}`, res.status === 200 && body.package?.name === name,
      res.status === 200 ? '' : `HTTP ${res.status} ${JSON.stringify(body).slice(0, 140)}`);
  }

  const listed = await fetch(`${B}/api/nodes/store`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  const listedGeneric = (listed.packages ?? [])
    .filter((item) => [OK_PKG, DENIED_PKG].includes(item.module));
  requireCheck('包库精确列出两个当前夹具且无依赖缺口', listedGeneric.length === 2
    && listedGeneric.every((p) => p.missingDeps.length === 0 && p.isNodeRedNode));
  check('包库保留固定 Edge/common 根且版本精确',
    listed.packages?.some((item) => item.module === PLATFORM_NODE_PACKAGE.name
      && item.versions?.includes(PLATFORM_NODE_PACKAGE.version))
    && listed.packages?.some((item) => item.module === PLATFORM_COMMON_PACKAGE.name
      && item.versions?.includes(PLATFORM_COMMON_PACKAGE.version)));

  // ── 1b. URL 依赖夹具：先只导节点包，故意不导它的依赖 ──
  const importRaw = async (bytes) => {
    const res = await fetch(`${B}/api/nodes/store`, {
      method: 'POST',
      headers: { ...H(admin), 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const urlDep = await importRaw(fixture(URLDEP_PKG, '1.0.0', { [URLDEP_LIB]: UNREACHABLE }));
  check('导入依赖写成 URL 的节点包', urlDep.status === 200, `HTTP ${urlDep.status}`);
  // 依赖缺口按**名字**报 —— 不管声明写的是版本范围还是一个 URL
  check('URL 依赖没导进来时照样报成缺口（写法不影响判断）',
    urlDep.body.missingDeps?.includes(URLDEP_LIB),
    `missingDeps=${JSON.stringify(urlDep.body.missingDeps)}`);

  const urlLib = await importRaw(plainLib(URLDEP_LIB));
  check('导入那个被 URL 指向的依赖包', urlLib.status === 200, `HTTP ${urlLib.status}`);

  const packument = await fetch(`${B}/npm/${URLDEP_PKG}`).then((r) => r.json());
  check('packument 把 URL 依赖改写成库里的版本（否则 npm 会绕开私有源出网）',
    packument.versions?.['1.0.0']?.dependencies?.[URLDEP_LIB] === '1.0.0',
    `实际 ${JSON.stringify(packument.versions?.['1.0.0']?.dependencies)}`);

  const approvedUrlDep = await fetch(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: URLDEP_PKG, note: 'URL 依赖夹具' }),
  });
  check(`批准 ${URLDEP_PKG}`, approvedUrlDep.status === 200, `HTTP ${approvedUrlDep.status}`);

  // ── 2. 只批准其中一个 ─────────────────────────────
  const approved = await fetch(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: OK_PKG, note: '验证夹具' }),
  });
  const approvedBody = await approved.json().catch(() => ({}));
  check(`批准 ${OK_PKG}`, approved.status === 200 && approvedBody.entry?.module === OK_PKG,
    `HTTP ${approved.status}`);
  check('批准不会自动下发（下发要重启实例，不能是「保存」的副作用）',
    approvedBody.applied === false, `applied=${approvedBody.applied}`);

  const cat = await fetch(`${B}/npm/-/catalogue.json`).then((r) => r.json());
  const catIds = (cat.modules ?? []).map((m) => m.id).sort();
  check('Community catalogue 使用统一英文命名',
    cat.name === 'ThingLinks Edge Community catalogue',
    `实际 ${JSON.stringify(cat.name)}`);
  check('私有 catalogue 只列普通批准包与固定 Edge，永不列 common',
    catIds.length === 3
      && catIds.includes(OK_PKG)
      && catIds.includes(URLDEP_PKG)
      && catIds.includes(PLATFORM_NODE_PACKAGE.name)
      && !catIds.includes(PLATFORM_COMMON_PACKAGE.name),
    `实际 ${JSON.stringify(catIds)}`);

  // ── 3. 起实例（settings 由当前批准清单生成）─────────
  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ id: ID, name: ID, imageTag: TAG, memoryMb: 512, cpus: 0.5, ports: [] }),
  });
  const createdBody = await created.json().catch(() => ({}));
  requireCheck('创建实例完成真实 npm bootstrap', created.status === 201,
    created.status === 201 ? '' : `HTTP ${created.status} ${JSON.stringify(createdBody).slice(0, 200)}`);
  requireCheck('bootstrap 在启动前建立双向桥接', bootstrapBridgesReady);
  requireCheck('新实例容器与网络归属精确且可按不可变 ID 解析',
    Boolean(await exactContainer(containerName(ID))) && Boolean(await exactNetwork()));

  let state = 'missing';
  for (let i = 0; i < 40 && state !== 'running'; i++) { await sleep(1000); state = await containerState(ID); }
  requireCheck('实例容器在运行', state === 'running', `state=${state}`);

  // 容器里的实际配置 —— 不看生成函数的输出，看落到盘上的那一份
  const settings = await catInContainer(ID, '/data/settings.js');
  check('实例 settings.js 里 denyList 为 ["*"]（为空会让白名单校验整段跳过）',
    /denyList:\s*\["\*"\]/.test(settings));
  // 固定 Edge 与两个普通批准包都要在；common 只是依赖，绝不进 allowList。
  const expectedAllowList = [
    `${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
    OK_PKG,
    URLDEP_PKG,
  ].sort();
  check('实例 settings.js 里 allowList 精确含固定 Edge 与普通批准包，不含 common',
    settings.includes(`allowList: ${JSON.stringify(expectedAllowList)}`)
      && !settings.includes(PLATFORM_COMMON_PACKAGE.name),
    /allowList:.*/.exec(settings)?.[0]?.slice(0, 120) ?? '没找到 allowList');
  check('实例 settings.js 里 allowUpload:false（老写法 editorTheme.palette.upload 已拦不住）',
    /allowUpload:\s*false/.test(settings));
  check('实例 settings.js 里 catalogues 指向私有源，不是公网',
    settings.includes('/npm/-/catalogue.json') && !settings.includes('catalogue.nodered.org'));

  const env = await raw.getContainer(containerName(ID)).inspect().then((i) => i.Config.Env);
  check('容器环境里有 NPM_CONFIG_REGISTRY（.npmrc 够不着装包前的 npm info）',
    env.some((e) => e === `NPM_CONFIG_REGISTRY=http://${BRIDGE_OUT}:${REG_PORT}/npm/`),
    env.filter((e) => e.startsWith('NPM_CONFIG')).join(' ') || '一个都没有');

  // ── 4. 双向边车已在 bootstrap 的 after-container-create 边界启动 ──
  await sleep(1000);

  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/settings`).catch(() => null);
      if (r && r.status < 500) return true;
      await sleep(1000);
    }
    return false;
  };
  check('实例 Admin API 就绪', await ready());

  // 实例侧真能读到私有源
  const fromInside = await execInContainer(ID,
    ['sh', '-c', `cd /usr/src/node-red && npm view ${OK_PKG} version 2>&1 | tail -3`]);
  check('容器内 npm 从私有源读得到夹具包（证明 registry 生效）',
    fromInside.includes('1.0.0'), fromInside.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120));

  // ── 5. 白名单：批过的能装，没批的装不上 ──────────
  const token = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'node-red-editor', grant_type: 'password', scope: '*',
      username: 'admin', password: repo.credentials(ID)[0].password,
    }),
  }).then((r) => r.json()).catch(() => ({}));

  const install = async (mod) => {
    const res = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token.access_token ? { authorization: `Bearer ${token.access_token}` } : {}),
      },
      body: JSON.stringify({ module: mod }),
    });
    return { status: res.status, body: await res.text() };
  };

  const okInstall = await install(OK_PKG);
  check('已批准的节点从私有源装成功（公网无此包 ⇒ 只能来自私有源）',
    okInstall.status >= 200 && okInstall.status < 300,
    `HTTP ${okInstall.status} ${okInstall.body.slice(0, 200)}`);

  /*
   * 这一条是整个离线保证里最容易破的一环：
   * 依赖写成 URL 的包，装的时候 npm 会不会绕过私有源去连那个域名。
   * UNREACHABLE 的主机名在容器里解析不了，所以**装成功 ⇒ 它没去连**。
   */
  const urlDepInstall = await install(URLDEP_PKG);
  check('依赖写成 URL 的节点也能装上（证明 npm 没绕开私有源去连那个域名）',
    urlDepInstall.status >= 200 && urlDepInstall.status < 300,
    `HTTP ${urlDepInstall.status} ${urlDepInstall.body.slice(0, 200)}`);

  const deniedInstall = await install(DENIED_PKG);
  check('未批准的节点被拒（库里有、只差批准，隔离出白名单这一个变量）',
    deniedInstall.status === 400 && deniedInstall.body.includes('install_not_allowed'),
    `HTTP ${deniedInstall.status} ${deniedInstall.body.slice(0, 200)}`);

  // ── 在线搜索与版本列表（批准对话框全靠这两条）──
  const searched = await fetch(`${B}/api/nodes/search?q=fixture`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  check('在线搜索能搜到源里的包',
    searched.enabled === true && searched.hits?.some((h) => h.name === UPSTREAM_PKG),
    `enabled=${searched.enabled} hits=${(searched.hits ?? []).map((h) => h.name).join(',')}`);
  check('搜索结果带来源，多源时人得知道包是哪来的',
    searched.hits?.[0]?.source === '假上游', searched.hits?.[0]?.source);

  const vers = await fetch(
    `${B}/api/nodes/versions?module=${encodeURIComponent(UPSTREAM_PKG)}`,
    { headers: { cookie: admin.cookie } },
  ).then((r) => r.json());
  check('**选中一个包能列出它的版本**（批准对话框的版本下拉靠它）',
    Array.isArray(vers.versions) && vers.versions.length > 0
      && vers.versions[0].version === '1.0.0',
    JSON.stringify(vers).slice(0, 200));

  // ── 上游回源：批准了但库里没有的包，应当自动下载并入库 ──
  await fetch(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: UPSTREAM_PKG, note: '回源验证' }),
  });
  // 批准改了要重新下发，实例侧的 allowList 才认它
  await fetch(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  });
  await sleep(3000);
  await ready();

  const beforeStore = await fetch(`${B}/api/nodes/store`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  check('回源前库里确实没有这个包（否则下面证明不了什么）',
    !beforeStore.packages?.some((p) => p.module === UPSTREAM_PKG));

  const token2 = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'node-red-editor', grant_type: 'password', scope: '*',
      username: 'admin', password: repo.credentials(ID)[0].password,
    }),
  }).then((r) => r.json()).catch(() => ({}));

  const upInstall = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token2.access_token ? { authorization: `Bearer ${token2.access_token}` } : {}),
    },
    body: JSON.stringify({ module: UPSTREAM_PKG }),
  });
  const upBody = await upInstall.text();
  check('**库里没有的包能从上游下载并装上**（公网无此包 ⇒ 只能来自假上游）',
    upInstall.status >= 200 && upInstall.status < 300,
    `HTTP ${upInstall.status} ${upBody.slice(0, 160)}`);

  const afterStore = await fetch(`${B}/api/nodes/store`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  check('**下载的包顺手入库了**（下次即离线可用）',
    afterStore.packages?.some((p) => p.module === UPSTREAM_PKG),
    (afterStore.packages ?? []).map((p) => p.module).join(', '));

  // ── 从控制台直接装到实例 ──
  const viaConsole = await fetch(`${B}/api/instances/${ID}/nodes`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: OK_PKG }),
  });
  const viaBody = await viaConsole.json().catch(() => ({}));
  check('控制台装到实例：已装过的包如实回报，不是静默成功',
    viaConsole.status === 400 && /已经装过/.test(viaBody.error ?? ''),
    `HTTP ${viaConsole.status} ${(viaBody.error ?? '').slice(0, 80)}`);

  const denyViaConsole = await fetch(`${B}/api/instances/${ID}/nodes`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: DENIED_PKG }),
  });
  const denyBody = await denyViaConsole.json().catch(() => ({}));
  check('**从控制台装也过白名单**（不能绕过实例侧的闸门）',
    denyViaConsole.status === 400 && /批准清单/.test(denyBody.error ?? ''),
    `HTTP ${denyViaConsole.status} ${(denyBody.error ?? '').slice(0, 100)}`);

  const installNoCsrf = await fetch(`${B}/api/instances/${ID}/nodes`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ module: OK_PKG }),
  });
  check('控制台装节点要过 CSRF', installNoCsrf.status === 403, `HTTP ${installNoCsrf.status}`);

  // tgz 上传：老写法拦不住，必须靠 externalModules.palette.allowUpload
  const upload = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
    method: 'POST',
    headers: token.access_token ? { authorization: `Bearer ${token.access_token}` } : {},
    body: (() => {
      const fd = new FormData();
      fd.append('tarball', new Blob([fixture('node-red-contrib-tle-fixture-upload')]), 'x.tgz');
      return fd;
    })(),
  });
  const uploadBody = await upload.text();
  check('tgz 上传被拒（未到解包阶段 ⇒ 闸门在前面）',
    uploadBody.includes('invalid_request'),
    `HTTP ${upload.status} ${uploadBody.slice(0, 160)}`);

  // ── 6. 平台侧台账 ────────────────────────────────
  const inv = await fetch(`${B}/api/nodes/inventory/${ID}`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  const okItem = inv.modules?.find((m) => m.module === OK_PKG);
  const platformItem = inv.modules?.find((m) => m.module === PLATFORM_NODE_PACKAGE.name);
  check('台账看得到刚装上的节点，且判为合规', okItem?.compliance === 'approved',
    `实际 ${JSON.stringify(okItem ?? null)}`);
  check('固定 Edge 在真实 bootstrap 后精确加载且判为 platform',
    platformItem?.compliance === 'platform'
      && platformItem.version === PLATFORM_NODE_PACKAGE.version
      && platformItem.health === 'healthy',
    `实际 ${JSON.stringify(platformItem ?? null).slice(0, 180)}`);
  check('common 只作为 Edge 依赖存在，不进入 Node-RED 台账',
    !inv.modules?.some((m) => m.module === PLATFORM_COMMON_PACKAGE.name));
  check('台账把镜像自带的节点判为 builtin',
    inv.modules?.find((m) => m.module === 'node-red')?.compliance === 'builtin');
  check('台账此刻没有未批准项', inv.unapproved === 0, `unapproved=${inv.unapproved}`);

  // 撤销批准 → 已装的那个立刻变成「未批准」，这就是漂移检测
  await fetch(`${B}/api/nodes/catalog/${encodeURIComponent(OK_PKG)}`, {
    method: 'DELETE', headers: H(admin),
  });
  const inv2 = await fetch(`${B}/api/nodes/inventory/${ID}`, { headers: { cookie: admin.cookie } })
    .then((r) => r.json());
  check('撤销批准后台账把已装的那个标为未批准（发现清单与实际的漂移）',
    inv2.unapproved === 1
    && inv2.modules.find((m) => m.module === OK_PKG)?.compliance === 'unapproved',
    `unapproved=${inv2.unapproved}`);

  // 另一个也撤掉；UPSTREAM_PKG 仍获批准，固定 Edge 也不可撤销。
  await fetch(`${B}/api/nodes/catalog/${encodeURIComponent(URLDEP_PKG)}`, {
    method: 'DELETE', headers: H(admin),
  });

  // ── 7. 下发策略：重写 settings 并重启 ─────────────
  const applied = await fetch(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  }).then((r) => r.json());
  check('下发策略到实例并重启', applied.results?.[0]?.ok === true && applied.results[0].restarted === true,
    JSON.stringify(applied.results?.[0] ?? null));

  await sleep(3000);
  const settings2 = await catInContainer(ID, '/data/settings.js');
  check('撤销两个普通批准后白名单精确保留固定 Edge 与仍批准的回源包',
    settings2.includes(`allowList: ${JSON.stringify([
      `${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
      UPSTREAM_PKG,
    ].sort())}`)
      && !settings2.includes(OK_PKG)
      && !settings2.includes(URLDEP_PKG)
      && !settings2.includes(PLATFORM_COMMON_PACKAGE.name)
      && /denyList:\s*\["\*"\]/.test(settings2));

  // ── 8. open：公共目录只在显式放开时出现，下载仍由私有 registry 完成 ──
  paletteMode = 'open';
  const opened = await fetch(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  }).then((r) => r.json());
  check('切到 open 后下发策略并重启实例',
    opened.results?.[0]?.ok === true && opened.results[0].restarted === true,
    JSON.stringify(opened.results?.[0] ?? null));

  await sleep(3000);
  await ready();
  const openSettings = await catInContainer(ID, '/data/settings.js');
  check('open settings 放开安装并保留上传和更新禁用',
    openSettings.includes('allowList: ["*"]')
      && /denyList:\s*\[\]/.test(openSettings)
      && /allowUpload:\s*false/.test(openSettings)
      && /allowUpdate:\s*false/.test(openSettings));
  const openCatalogues = cataloguesFromSettings(openSettings);
  check('open settings catalogue 精确为私有目录后接官方目录',
    JSON.stringify(openCatalogues) === JSON.stringify(['/npm/-/catalogue.json', PUBLIC_CATALOGUE_URL]),
    `实际 ${JSON.stringify(openCatalogues)}`);

  const token3 = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'node-red-editor', grant_type: 'password', scope: '*',
      username: 'admin', password: repo.credentials(ID)[0].password,
    }),
  }).then((r) => r.json()).catch(() => ({}));
  const openInstall = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token3.access_token ? { authorization: `Bearer ${token3.access_token}` } : {}),
    },
    body: JSON.stringify({ module: DENIED_PKG }),
  });
  const openBody = await openInstall.text();
  check('open 模式可从私有 registry 自助安装此前未批准的包（不依赖公网包存在）',
    openInstall.status >= 200 && openInstall.status < 300,
    `HTTP ${openInstall.status} ${openBody.slice(0, 200)}`);

  // ── 9. 权限 ──────────────────────────────────────
  const anon = await fetch(`${B}/api/nodes/catalog`);
  check('未登录读不到批准清单', anon.status === 401, `HTTP ${anon.status}`);
  const anonApprove = await fetch(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: 'whatever' }),
  });
  check('未登录改不了批准清单', anonApprove.status === 401, `HTTP ${anonApprove.status}`);
  const noCsrf = await fetch(`${B}/api/nodes/catalog`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ module: 'whatever' }),
  });
  check('改批准清单要过 CSRF', noCsrf.status === 403, `HTTP ${noCsrf.status}`);
}

main()
  .catch((e) => { console.error('\n验证脚本自身出错：', e); results.push({ name: '脚本执行', ok: false }); })
  .finally(async () => {
    await server?.close().catch(() => {});
    upstreamServer?.close();
    if (nodeStore) {
      try {
        cleanupGenericFixtures(nodeStore);
        check('只清理五个精确命名的普通夹具包',
          GENERIC_FIXTURE_PACKAGES.every((name) => nodeStore.versions(name).length === 0));
        check('固定 Edge/common 信任根字节在验证前后保持不变',
          [PLATFORM_NODE_PACKAGE, PLATFORM_COMMON_PACKAGE].every((pin) => {
            const bytes = nodeStore.tarball(pin.name, pin.version);
            return bytes
              && createHash('sha256').update(bytes).digest('hex') === protectedDigests?.get(pin.name);
          }));
      } catch (error) {
        check('普通夹具清理与固定信任根复核', false, error.message);
      }
    }
    const cleanupFailures = await cleanup();
    check('随机资源按不可变 ID 与归属标签清理干净', cleanupFailures.length === 0,
      cleanupFailures.join(' | '));
    const bad = results.filter((r) => !r.ok);
    console.log(`\n节点管理验证：${results.length - bad.length}/${results.length} 通过`);
    if (bad.length > 0) {
      console.log('未通过：');
      for (const r of bad) console.log(`  ✗ ${r.name}`);
    }
    process.exit(bad.length === 0 ? 0 : 1);
  });
