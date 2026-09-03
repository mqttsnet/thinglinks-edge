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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

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
  PLATFORM_NODE_TYPES,
} from '../dist/core/nodes/platform-contract.js';
import {
  assembleInstanceAdminRuntime,
  assemblePlatformNodeServices,
  assemblePlatformOperationBarrier,
} from '../dist/index.js';
import { tarArchive, untar } from '../dist/core/archive/tar.js';
import { adminSession } from './_session.mjs';

const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 12);
const NET = `tle-nodes-net-${RUN_ID}`;
const BRIDGE_IN = `tle-nodes-bridge-in-${RUN_ID}`;  // 宿主 → 实例
const BRIDGE_OUT = `tle-nodes-bridge-out-${RUN_ID}`; // 实例 → 宿主（私有源）
const SEED_CONTAINER = `tle-nodes-seed-${RUN_ID}`;
const REG_PORT = 19100;
const ADMIN_PW = randomBytes(24).toString('base64url');
const ADMIN_NEXT_PW = randomBytes(24).toString('base64url');
const ID = `nodes-${RUN_ID}`;
const TAG = '5.0.4-24-minimal';
const PUBLIC_CATALOGUE_URL = 'https://catalogue.nodered.org/catalogue.json';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const BOOTSTRAP_TX_LABEL = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
const VERIFY_RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verify-run';
const VERIFY_ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verify-role';
const NETWORK_NAME = `${NET}-${ID}`;
const PRIVATE_TMP = '/private/tmp';
const REVIEWED_MANAGER_IMAGE = process.env.MANAGER_IMAGE?.trim() ?? '';

let PORT;
let NR_PORT;
let UPSTREAM_PORT;
let RUN_ROOT;
let TEST_EDGE_ROOT;
let TEST_DATA_ROOT;
let bootstrapTxId;

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
let failFast = true;
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok && failFast) {
    throw new Error(`前置条件失败：${name}${detail ? `（${detail}）` : ''}`);
  }
};
const normalizeExactKeywords = (keywords) => {
  if (
    !Array.isArray(keywords)
    || !keywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0)
  ) return undefined;
  const normalized = [...keywords].sort();
  return new Set(normalized).size === normalized.length ? normalized : undefined;
};
const isExactPlatformCatalogueEntry = (entry, expectedKeywords) => {
  const expectedKeys = ['description', 'id', 'keywords', 'types', 'updated_at', 'version'];
  const actualKeywords = normalizeExactKeywords(entry?.keywords);
  const normalizedExpectedKeywords = normalizeExactKeywords(expectedKeywords);
  return entry !== null
    && typeof entry === 'object'
    && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(expectedKeys)
    && entry.id === PLATFORM_NODE_PACKAGE.name
    && PLATFORM_NODE_PACKAGE.version === '0.0.1'
    && entry.version === PLATFORM_NODE_PACKAGE.version
    && typeof entry.description === 'string'
    && entry.description.length > 0
    && typeof entry.updated_at === 'string'
    && entry.updated_at.length > 0
    && actualKeywords !== undefined
    && normalizedExpectedKeywords !== undefined
    // catalogue 不承诺关键词顺序；排序副本后精确比较，缺失/重复/额外项均拒绝。
    && JSON.stringify(actualKeywords) === JSON.stringify(normalizedExpectedKeywords)
    && Array.isArray(entry.types)
    && JSON.stringify([...entry.types].sort()) === JSON.stringify([...PLATFORM_NODE_TYPES].sort());
};
const cataloguesFromSettings = (settings) => {
  const match = /^\s*catalogues:\s*(\[[^\r\n]*\])/m.exec(settings);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
};
const fetchJson = async (url, options, label) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回非 JSON（HTTP ${response.status}）`);
  }
  return { response, body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDockerNotFound = (error) => error?.statusCode === 404;
const isFsNotFound = (error) => error?.code === 'ENOENT';

const inspectContainer = async (ref) => raw.getContainer(ref).inspect().catch((error) => {
  if (isDockerNotFound(error)) return undefined;
  throw error;
});
const inspectNetwork = async (ref) => raw.getNetwork(ref).inspect().catch((error) => {
  if (isDockerNotFound(error)) return undefined;
  throw error;
});
const containerState = async (id) => {
  const info = await inspectContainer(containerName(id));
  return info?.State.Status ?? 'missing';
};

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

const verifyLabels = (role) => ({
  [VERIFY_RUN_LABEL]: RUN_ID,
  [INSTANCE_LABEL]: ID,
  [VERIFY_ROLE_LABEL]: role,
  ...(role.startsWith('bridge-') && bootstrapTxId
    ? { [BOOTSTRAP_TX_LABEL]: bootstrapTxId }
    : {}),
});
const managedInstanceScope = () => ({
  [MANAGED_LABEL]: 'true',
  [INSTANCE_LABEL]: ID,
});
const managedInstanceLabels = () => ({
  ...managedInstanceScope(),
  ...(bootstrapTxId ? { [BOOTSTRAP_TX_LABEL]: bootstrapTxId } : {}),
});
const expectedVerifyNames = new Map([
  ['bridge-in', BRIDGE_IN],
  ['bridge-out', BRIDGE_OUT],
  ['seed-source', SEED_CONTAINER],
]);
const immutableContainerIds = new Map();
let immutableNetworkId;

const hasAllLabels = (actual, expected) => Object.entries(expected)
  .every(([key, value]) => actual?.[key] === value);
const labelFilters = (labels) => Object.entries(labels).map(([key, value]) => `${key}=${value}`);

const listVerifyContainers = () => raw.listContainers({
  all: true,
  filters: { label: labelFilters({ [VERIFY_RUN_LABEL]: RUN_ID, [INSTANCE_LABEL]: ID }) },
});
const listManagedInstanceContainers = () => raw.listContainers({
  all: true,
  filters: { label: labelFilters(managedInstanceScope()) },
});
const listVerifyNetworks = () => raw.listNetworks({
  filters: { label: labelFilters(managedInstanceScope()) },
});

async function assertRunRoot(path) {
  if (!path) throw new Error('随机验证根尚未创建');
  const parent = await realpath(PRIVATE_TMP);
  const actual = await realpath(path);
  const stat = await lstat(path);
  const rel = relative(parent, actual);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || dirname(actual) !== parent
    || rel.startsWith('..')
    || resolve(parent, rel) !== actual
    || !basename(actual).startsWith(`tle-nodes-${RUN_ID}-`)
  ) throw new Error(`随机验证根越界：${actual}`);
  return actual;
}

async function createRunRoot() {
  const parent = await realpath(PRIVATE_TMP);
  const root = await mkdtemp(`${parent}/tle-nodes-${RUN_ID}-`);
  RUN_ROOT = root;
  RUN_ROOT = await assertRunRoot(root);
  TEST_EDGE_ROOT = RUN_ROOT;
  TEST_DATA_ROOT = `${RUN_ROOT}/instances`;
  await chmod(RUN_ROOT, 0o777);
  await mkdir(`${RUN_ROOT}/manager/npm`, { recursive: true, mode: 0o777 });
  await mkdir(TEST_DATA_ROOT, { recursive: true, mode: 0o777 });
}

async function createVerifyContainer(options, role, start = false) {
  const expectedName = expectedVerifyNames.get(role);
  if (!expectedName || options.name !== expectedName) throw new Error(`未知验证容器角色：${role}`);
  const container = await raw.createContainer({ ...options, Labels: verifyLabels(role) });
  const info = await inspectContainer(container.id);
  if (
    !info
    || info.Id !== container.id
    || info.Name !== `/${expectedName}`
    || !hasAllLabels(info.Config?.Labels, verifyLabels(role))
  ) throw new Error(`验证容器身份或归属不一致：${expectedName}`);
  immutableContainerIds.set(expectedName, info.Id);
  if (start) await raw.getContainer(info.Id).start();
  return info;
}

async function exactInstanceContainer() {
  const info = await inspectContainer(containerName(ID));
  if (
    !info
    || info.Name !== `/${containerName(ID)}`
    || !hasAllLabels(info.Config?.Labels, managedInstanceLabels())
  ) throw new Error('bootstrap 实例容器身份或归属不一致');
  const captured = immutableContainerIds.get(containerName(ID));
  if (captured && captured !== info.Id) throw new Error('bootstrap 实例容器不可变 ID 已变化');
  immutableContainerIds.set(containerName(ID), info.Id);
  return info;
}

async function exactNetwork() {
  const info = await inspectNetwork(immutableNetworkId ?? NETWORK_NAME);
  if (
    !info
    || info.Name !== NETWORK_NAME
    || !hasAllLabels(info.Labels, managedInstanceLabels())
    || (immutableNetworkId && immutableNetworkId !== info.Id)
  ) throw new Error('随机实例网络不可变 ID 或归属已变化');
  immutableNetworkId = info.Id;
  return info;
}

async function assertScopedResourcesEmpty() {
  const [verifyContainers, managedContainers, networks] = await Promise.all([
    listVerifyContainers(), listManagedInstanceContainers(), listVerifyNetworks(),
  ]);
  if (verifyContainers.length || managedContainers.length || networks.length) {
    throw new Error(
      `随机归属资源非空 containers=${verifyContainers.length + managedContainers.length}`
      + ` networks=${networks.length}`,
    );
  }
}

async function createBootstrapBridges(docker) {
  const network = await exactNetwork();
  const instance = await exactInstanceContainer();
  if (!network || !instance) throw new Error('bootstrap 容器或实例网络尚未形成');

  await createVerifyContainer({
    name: BRIDGE_IN,
    Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${NR_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    ExposedPorts: { [`${NR_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      PortBindings: { [`${NR_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(NR_PORT) }] },
    },
  }, 'bridge-in', true);
  await createVerifyContainer({
    name: BRIDGE_OUT,
    Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${REG_PORT},fork,reuseaddr`, `TCP:host.docker.internal:${PORT}`],
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
  }, 'bridge-out', true);
}

async function assertTargetsAbsent() {
  await assertScopedResourcesEmpty();
  for (const name of [BRIDGE_IN, BRIDGE_OUT, SEED_CONTAINER, containerName(ID)]) {
    const existing = await inspectContainer(name);
    if (existing) throw new Error(`随机验证容器名已存在，拒绝启动：${name}`);
  }
  const network = await inspectNetwork(NETWORK_NAME);
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
  const exec = await raw.getContainer(containerName(id)).exec({
    Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true,
  });
  const stream = await exec.start({ hijack: true });
  await new Promise((resolveStream, reject) => {
    stream.on('data', (c) => { out += c.toString('utf8'); });
    stream.on('end', resolveStream);
    stream.on('error', reject);
  });
  const result = await exec.inspect();
  if (result.ExitCode !== 0) throw new Error(`容器命令失败 exit=${result.ExitCode}`);
  return out;
}

const catInContainer = (id, file) => execInContainer(id, ['cat', file]);

const streamBuffer = (stream, maxBytes = 64 * 1024 * 1024) => new Promise((resolveBuffer, reject) => {
  const chunks = [];
  let size = 0;
  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy(new Error('Manager seed archive exceeds 64 MiB'));
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  stream.on('end', () => resolveBuffer(Buffer.concat(chunks)));
  stream.on('error', reject);
});

async function removeVerifyContainer(id, name, role) {
  const info = await inspectContainer(id);
  if (!info) return;
  if (
    info.Id !== id
    || info.Name !== `/${name}`
    || !hasAllLabels(info.Config?.Labels, verifyLabels(role))
  ) throw new Error(`拒绝删除身份或归属不匹配的验证容器 ${name}`);
  await raw.getContainer(info.Id).remove({ force: true });
}

async function resolveReviewedManagerImage() {
  if (!REVIEWED_MANAGER_IMAGE) {
    throw new Error('verify-nodes requires explicit MANAGER_IMAGE pointing to the reviewed Manager image');
  }
  let info;
  try {
    info = await raw.getImage(REVIEWED_MANAGER_IMAGE).inspect();
  } catch (error) {
    throw new Error(`MANAGER_IMAGE is unavailable: ${error.message}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(info.Id)) {
    throw new Error('MANAGER_IMAGE did not resolve to an immutable sha256 image ID');
  }
  return info.Id;
}

async function seedProtectedPlatformPackages(store, imageId) {
  const seed = await createVerifyContainer({
    name: SEED_CONTAINER,
    Image: imageId,
    NetworkDisabled: true,
    HostConfig: { NetworkMode: 'none' },
  }, 'seed-source');
  try {
    const archive = await streamBuffer(
      await raw.getContainer(seed.Id).getArchive({ path: '/app/npm-seed' }),
    );
    const entries = untar(archive);
    const wanted = new Map([
      [`mqttsnet-thinglinks-edge-nodes-${PLATFORM_NODE_PACKAGE.version}.tgz`, PLATFORM_NODE_PACKAGE],
      [`mqttsnet-thinglinks-node-red-common-${PLATFORM_COMMON_PACKAGE.version}.tgz`, PLATFORM_COMMON_PACKAGE],
    ]);
    const found = new Map();
    for (const entry of entries) {
      const pin = wanted.get(basename(entry.name));
      if (!pin) continue;
      if (found.has(pin.name)) throw new Error(`Manager image has duplicate seed for ${pin.name}`);
      const bytes = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
      const meta = store.add(bytes);
      if (meta.name !== pin.name || meta.version !== pin.version || meta.integrity !== pin.integrity) {
        throw new Error(`Manager image seed does not match ${pin.name}@${pin.version}`);
      }
      found.set(pin.name, bytes);
    }
    for (const pin of [PLATFORM_NODE_PACKAGE, PLATFORM_COMMON_PACKAGE]) {
      if (!found.has(pin.name)) throw new Error(`Manager image is missing reviewed seed ${pin.name}`);
    }
  } finally {
    await removeVerifyContainer(seed.Id, SEED_CONTAINER, 'seed-source');
  }
}

async function inspectExpectedContainerNames(remember) {
  const targets = [
    ...[...expectedVerifyNames.entries()].map(([role, name]) => ({
      name,
      labels: verifyLabels(role),
    })),
    { name: containerName(ID), labels: managedInstanceLabels() },
  ];
  for (const target of targets) {
    try {
      const info = await inspectContainer(target.name);
      if (!info) continue;
      remember(new Error(`标签清理后容器名仍被占用：${target.name}`));
      const immutableId = immutableContainerIds.get(target.name);
      if (
        immutableId
        && info.Id === immutableId
        && info.Name === `/${target.name}`
        && hasAllLabels(info.Config?.Labels, target.labels)
      ) {
        try {
          await raw.getContainer(info.Id).remove({ force: true });
        } catch (error) {
          remember(error);
        }
      }
    } catch (error) {
      remember(error);
    }
  }
}

async function inspectExpectedNetworkName(remember) {
  try {
    const info = await inspectNetwork(NETWORK_NAME);
    if (!info) return;
    remember(new Error(`标签清理后网络名仍被占用：${NETWORK_NAME}`));
    if (
      immutableNetworkId
      && info.Id === immutableNetworkId
      && info.Name === NETWORK_NAME
      && hasAllLabels(info.Labels, managedInstanceLabels())
    ) {
      try {
        await raw.getNetwork(info.Id).remove();
      } catch (error) {
        remember(error);
      }
    }
  } catch (error) {
    remember(error);
  }
}

async function cleanup() {
  const failures = [];
  const remember = (error) => failures.push(error instanceof Error ? error.message : String(error));

  // 验证边车/seed：只枚举同时命中本次随机 run + instance 的容器。
  try {
    for (const summary of await listVerifyContainers()) {
      try {
        const info = await inspectContainer(summary.Id);
        const role = info?.Config?.Labels?.[VERIFY_ROLE_LABEL];
        const expectedName = expectedVerifyNames.get(role);
        if (
          !info
          || info.Id !== summary.Id
          || !expectedName
          || info.Name !== `/${expectedName}`
          || !hasAllLabels(info.Config?.Labels, verifyLabels(role))
          || (immutableContainerIds.get(expectedName)
            && immutableContainerIds.get(expectedName) !== info.Id)
        ) throw new Error(`拒绝清理身份或归属不匹配的验证容器 ${summary.Id}`);
        await raw.getContainer(info.Id).remove({ force: true });
      } catch (error) {
        remember(error);
      }
    }
  } catch (error) {
    remember(error);
  }

  // 产品实例没有 verifier 自定义标签；仍只枚举随机 instance + managed 的精确交集。
  try {
    for (const summary of await listManagedInstanceContainers()) {
      try {
        const info = await inspectContainer(summary.Id);
        if (
          !info
          || info.Id !== summary.Id
          || info.Name !== `/${containerName(ID)}`
          || !hasAllLabels(info.Config?.Labels, managedInstanceLabels())
          || (immutableContainerIds.get(containerName(ID))
            && immutableContainerIds.get(containerName(ID)) !== info.Id)
        ) throw new Error(`拒绝清理身份或归属不匹配的实例容器 ${summary.Id}`);
        await raw.getContainer(info.Id).remove({ force: true });
      } catch (error) {
        remember(error);
      }
    }
  } catch (error) {
    remember(error);
  }

  // 标签枚举之后逐一查固定随机名；无标签/错标签替换也必须被发现，且绝不误删。
  await inspectExpectedContainerNames(remember);

  // 所有容器处理完才处理网络；同样只枚举本次随机 run + instance 标签交集。
  try {
    for (const summary of await listVerifyNetworks()) {
      try {
        const info = await inspectNetwork(summary.Id);
        if (
          !info
          || info.Id !== summary.Id
          || info.Name !== NETWORK_NAME
          || !hasAllLabels(info.Labels, managedInstanceLabels())
          || (immutableNetworkId && immutableNetworkId !== info.Id)
        ) throw new Error(`拒绝清理身份或归属不匹配的实例网络 ${summary.Id}`);
        await raw.getNetwork(info.Id).remove();
      } catch (error) {
        remember(error);
      }
    }
  } catch (error) {
    remember(error);
  }

  await inspectExpectedNetworkName(remember);

  try {
    await assertScopedResourcesEmpty();
  } catch (error) {
    remember(error);
  }

  if (RUN_ROOT) {
    try {
      try {
        await lstat(RUN_ROOT);
      } catch (error) {
        if (isFsNotFound(error)) return failures;
        throw error;
      }
      const root = await assertRunRoot(RUN_ROOT);
      await rm(root, { recursive: true, force: false });
      try {
        await lstat(root);
        failures.push(`随机验证根残留 ${root}`);
      } catch (error) {
        if (!isFsNotFound(error)) throw error;
      }
    } catch (error) {
      remember(error);
    }
  }
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

const closeHttpServer = (httpServer) => new Promise((resolveClose, reject) => {
  if (!httpServer) { resolveClose(); return; }
  httpServer.close((error) => error ? reject(error) : resolveClose());
});

let server;
let upstreamServer;
let nodeStore;
let protectedDigests;
async function main() {
  const reviewedManagerImageId = await resolveReviewedManagerImage();
  [PORT, NR_PORT, UPSTREAM_PORT] = await Promise.all([
    allocatePort(), allocatePort(), allocatePort(),
  ]);
  await createRunRoot();
  await assertTargetsAbsent();
  check('显式 MANAGER_IMAGE 已解析并固定为不可变镜像 ID',
    /^sha256:[a-f0-9]{64}$/.test(reviewedManagerImageId));

  const dataDir = `${TEST_EDGE_ROOT}/manager`;
  const db = openDb(':memory:');
  const key = deriveKey('verify', 'salt');
  const repo = new InstanceRepo(db, key);
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);

  // 每轮用独占随机根，并从显式 reviewed Manager image 确定性提取固定 seed。
  const store = new NodeStore(`${dataDir}/npm`);
  nodeStore = store;
  await seedProtectedPlatformPackages(store, reviewedManagerImageId);
  const catalog = new NodeCatalog(db);
  const platformNodeServices = assemblePlatformNodeServices({ store, catalog });
  const trusted = platformNodeServices.platformPackages.verifyForInstall();
  const trustedPlatformCatalogueKeywords = Object.freeze([...trusted.meta.keywords]);
  const trustedCommon = platformNodeServices.platformPackages.snapshotForRegistry(
    PLATFORM_COMMON_PACKAGE.name,
    PLATFORM_COMMON_PACKAGE.version,
  );
  if (!trustedCommon) throw new Error('固定 common 信任根不可用');
  protectedDigests = new Map([
    [PLATFORM_NODE_PACKAGE.name, createHash('sha256').update(trusted.buffer).digest('hex')],
    [PLATFORM_COMMON_PACKAGE.name, createHash('sha256').update(trustedCommon.buffer).digest('hex')],
  ]);
  check('固定 Edge/common 信任根存在且完整性匹配',
    trusted.meta.name === PLATFORM_NODE_PACKAGE.name
      && trusted.meta.version === PLATFORM_NODE_PACKAGE.version
      && trusted.meta.integrity === PLATFORM_NODE_PACKAGE.integrity
      && trustedCommon.meta.name === PLATFORM_COMMON_PACKAGE.name
      && trustedCommon.meta.version === PLATFORM_COMMON_PACKAGE.version
      && trustedCommon.meta.integrity === PLATFORM_COMMON_PACKAGE.integrity);
  check('固定 Edge 被精确批准且 common 从不单独批准',
    catalog.get(PLATFORM_NODE_PACKAGE.name)?.version === PLATFORM_NODE_PACKAGE.version
      && catalog.get(PLATFORM_NODE_PACKAGE.name)?.note === PLATFORM_APPROVAL_NOTE
      && catalog.get(PLATFORM_COMMON_PACKAGE.name) === undefined);
  check('Edge 精确依赖 common，common 不是 Node-RED 节点包',
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
          bootstrapTxId = event.txId;
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
   * **这是验证脚手架的妥协**，生产默认只绑回环（见 config.listenAddr）。这里使用
   * 动态宿主端口、每轮随机管理口令和只接入本次私网的出向边车，口令从不输出。
   */
  await app.listen({ host: '0.0.0.0', port: PORT });
  server = app;
  const B = `http://127.0.0.1:${PORT}`;
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  const admin = await adminSession(B, ADMIN_PW, ADMIN_NEXT_PW);
  check('管理员登录成功', Boolean(admin.csrf));

  // ── 1. 往私有源导入两个夹具包 ─────────────────────
  for (const name of [OK_PKG, DENIED_PKG]) {
    const imported = await fetchJson(`${B}/api/nodes/store`, {
      method: 'POST',
      headers: { ...H(admin), 'content-type': 'application/octet-stream' },
      body: fixture(name),
    }, `导入节点包 ${name}`);
    check(`导入节点包 ${name}`,
      imported.response.status === 200 && imported.body.package?.name === name,
      imported.response.status === 200
        ? '' : `HTTP ${imported.response.status} ${JSON.stringify(imported.body).slice(0, 140)}`);
  }

  const listedResponse = await fetchJson(
    `${B}/api/nodes/store`, { headers: { cookie: admin.cookie } }, '读取离线包库',
  );
  check('读取离线包库', listedResponse.response.status === 200,
    `HTTP ${listedResponse.response.status}`);
  const listed = listedResponse.body;
  const listedGeneric = (listed.packages ?? [])
    .filter((item) => [OK_PKG, DENIED_PKG].includes(item.module));
  check('包库精确列出两个当前夹具且无依赖缺口', listedGeneric.length === 2
    && listedGeneric.every((p) => p.missingDeps.length === 0 && p.isNodeRedNode));
  check('包库保留固定 Edge/common 根且版本精确',
    listed.packages?.some((item) => item.module === PLATFORM_NODE_PACKAGE.name
      && item.versions?.includes(PLATFORM_NODE_PACKAGE.version))
    && listed.packages?.some((item) => item.module === PLATFORM_COMMON_PACKAGE.name
      && item.versions?.includes(PLATFORM_COMMON_PACKAGE.version)));

  // ── 1b. URL 依赖夹具：先只导节点包，故意不导它的依赖 ──
  const importRaw = async (bytes) => {
    const imported = await fetchJson(`${B}/api/nodes/store`, {
      method: 'POST',
      headers: { ...H(admin), 'content-type': 'application/octet-stream' },
      body: bytes,
    }, '导入依赖夹具');
    return { status: imported.response.status, body: imported.body };
  };

  const urlDep = await importRaw(fixture(URLDEP_PKG, '1.0.0', { [URLDEP_LIB]: UNREACHABLE }));
  check('导入依赖写成 URL 的节点包', urlDep.status === 200, `HTTP ${urlDep.status}`);
  // 依赖缺口按**名字**报 —— 不管声明写的是版本范围还是一个 URL
  check('URL 依赖没导进来时照样报成缺口（写法不影响判断）',
    urlDep.body.missingDeps?.includes(URLDEP_LIB),
    `missingDeps=${JSON.stringify(urlDep.body.missingDeps)}`);

  const urlLib = await importRaw(plainLib(URLDEP_LIB));
  check('导入那个被 URL 指向的依赖包', urlLib.status === 200, `HTTP ${urlLib.status}`);

  const packumentResponse = await fetchJson(`${B}/npm/${URLDEP_PKG}`, {}, '读取 URL 依赖 packument');
  check('读取 URL 依赖 packument', packumentResponse.response.status === 200,
    `HTTP ${packumentResponse.response.status}`);
  const packument = packumentResponse.body;
  check('packument 把 URL 依赖改写成库里的版本（否则 npm 会绕开私有源出网）',
    packument.versions?.['1.0.0']?.dependencies?.[URLDEP_LIB] === '1.0.0',
    `实际 ${JSON.stringify(packument.versions?.['1.0.0']?.dependencies)}`);

  const approvedUrlDep = await fetchJson(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: URLDEP_PKG, note: 'URL 依赖夹具' }),
  }, `批准 ${URLDEP_PKG}`);
  check(`批准 ${URLDEP_PKG}`,
    approvedUrlDep.response.status === 200 && approvedUrlDep.body.entry?.module === URLDEP_PKG,
    `HTTP ${approvedUrlDep.response.status}`);

  // ── 2. 只批准其中一个 ─────────────────────────────
  const approved = await fetchJson(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: OK_PKG, note: '验证夹具' }),
  }, `批准 ${OK_PKG}`);
  const approvedBody = approved.body;
  check(`批准 ${OK_PKG}`,
    approved.response.status === 200 && approvedBody.entry?.module === OK_PKG,
    `HTTP ${approved.response.status}`);
  check('批准不会自动下发（下发要重启实例，不能是「保存」的副作用）',
    approvedBody.applied === false, `applied=${approvedBody.applied}`);

  const catalogueResponse = await fetchJson(`${B}/npm/-/catalogue.json`, {}, '读取私有 catalogue');
  check('读取私有 catalogue', catalogueResponse.response.status === 200,
    `HTTP ${catalogueResponse.response.status}`);
  const cat = catalogueResponse.body;
  const catalogueModules = Array.isArray(cat.modules) ? cat.modules : [];
  const catIds = catalogueModules.map((m) => m.id).sort();
  const edgeCatalogueEntries = catalogueModules
    .filter((entry) => entry.id === PLATFORM_NODE_PACKAGE.name);
  check('Community catalogue 使用统一英文命名',
    cat.name === 'ThingLinks Edge Community catalogue',
    `实际 ${JSON.stringify(cat.name)}`);
  check('私有 catalogue 只列普通批准包与固定 Edge，永不列 common',
    catIds.length === 3
      && catIds.includes(OK_PKG)
      && catIds.includes(URLDEP_PKG)
      && catIds.includes(PLATFORM_NODE_PACKAGE.name)
      && catalogueModules.every((entry) => entry.id !== PLATFORM_COMMON_PACKAGE.name),
    `实际 ${JSON.stringify(catIds)}`);
  check('固定 Edge catalogue 条目契约精确',
    edgeCatalogueEntries.length === 1
      && isExactPlatformCatalogueEntry(
        edgeCatalogueEntries[0],
        trustedPlatformCatalogueKeywords,
      ),
    JSON.stringify(edgeCatalogueEntries[0] ?? null).slice(0, 240));

  // ── 3. 起实例（settings 由当前批准清单生成）─────────
  const created = await fetchJson(`${B}/api/instances`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ id: ID, name: ID, imageTag: TAG, memoryMb: 512, cpus: 0.5, ports: [] }),
  }, '创建实例');
  const createdBody = created.body;
  check('创建实例完成真实 npm bootstrap', created.response.status === 201,
    created.response.status === 201
      ? '' : `HTTP ${created.response.status} ${JSON.stringify(createdBody).slice(0, 200)}`);
  check('bootstrap 在启动前建立双向桥接', bootstrapBridgesReady);
  check('新实例容器与网络归属精确且可按不可变 ID 解析',
    Boolean(await exactInstanceContainer()) && Boolean(await exactNetwork()));

  let state = 'missing';
  for (let i = 0; i < 40 && state !== 'running'; i++) { await sleep(1000); state = await containerState(ID); }
  check('实例容器在运行', state === 'running', `state=${state}`);

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
    let lastError = '';
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/settings`).catch((error) => {
        lastError = error.message;
        return null;
      });
      if (r && r.status < 500) return true;
      await sleep(1000);
    }
    if (lastError) throw new Error(`实例 Admin API 未就绪：${lastError}`);
    return false;
  };
  check('实例 Admin API 就绪', await ready());

  const accessToken = async (label) => {
    const tokenResult = await fetchJson(`http://127.0.0.1:${NR_PORT}/red/${ID}/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'node-red-editor', grant_type: 'password', scope: '*',
        username: 'admin', password: repo.credentials(ID)[0].password,
      }),
    }, label);
    check(label,
      tokenResult.response.status === 200
        && typeof tokenResult.body.access_token === 'string'
        && tokenResult.body.access_token.length > 0,
      `HTTP ${tokenResult.response.status}`);
    return tokenResult.body.access_token;
  };

  // 实例侧真能读到私有源
  const fromInside = await execInContainer(ID,
    ['sh', '-c', `cd /usr/src/node-red && npm view ${OK_PKG} version 2>&1 | tail -3`]);
  check('容器内 npm 从私有源读得到夹具包（证明 registry 生效）',
    fromInside.includes('1.0.0'), fromInside.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120));

  // ── 5. 白名单：批过的能装，没批的装不上 ──────────
  const token = await accessToken('获取实例安装令牌');

  const install = async (mod) => {
    const res = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
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
  const searchedResponse = await fetchJson(
    `${B}/api/nodes/search?q=fixture`, { headers: { cookie: admin.cookie } }, '搜索上游节点包',
  );
  check('搜索上游节点包', searchedResponse.response.status === 200,
    `HTTP ${searchedResponse.response.status}`);
  const searched = searchedResponse.body;
  check('在线搜索能搜到源里的包',
    searched.enabled === true && searched.hits?.some((h) => h.name === UPSTREAM_PKG),
    `enabled=${searched.enabled} hits=${(searched.hits ?? []).map((h) => h.name).join(',')}`);
  check('搜索结果带来源，多源时人得知道包是哪来的',
    searched.hits?.[0]?.source === '假上游', searched.hits?.[0]?.source);

  const versionsResponse = await fetchJson(
    `${B}/api/nodes/versions?module=${encodeURIComponent(UPSTREAM_PKG)}`,
    { headers: { cookie: admin.cookie } },
    '读取上游节点版本',
  );
  check('读取上游节点版本', versionsResponse.response.status === 200,
    `HTTP ${versionsResponse.response.status}`);
  const vers = versionsResponse.body;
  check('**选中一个包能列出它的版本**（批准对话框的版本下拉靠它）',
    Array.isArray(vers.versions) && vers.versions.length > 0
      && vers.versions[0].version === '1.0.0',
    JSON.stringify(vers).slice(0, 200));

  // ── 上游回源：批准了但库里没有的包，应当自动下载并入库 ──
  const upstreamApproval = await fetchJson(`${B}/api/nodes/catalog`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ module: UPSTREAM_PKG, note: '回源验证' }),
  }, `批准 ${UPSTREAM_PKG}`);
  check(`批准 ${UPSTREAM_PKG}`,
    upstreamApproval.response.status === 200
      && upstreamApproval.body.entry?.module === UPSTREAM_PKG,
    `HTTP ${upstreamApproval.response.status}`);
  // 批准改了要重新下发，实例侧的 allowList 才认它
  const upstreamApply = await fetchJson(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  }, '下发回源包批准');
  check('下发回源包批准并重启实例',
    upstreamApply.response.status === 200
      && upstreamApply.body.results?.[0]?.ok === true
      && upstreamApply.body.results[0].restarted === true,
    `HTTP ${upstreamApply.response.status}`);
  await sleep(3000);
  check('回源包批准下发后实例重新就绪', await ready());

  const beforeStoreResponse = await fetchJson(
    `${B}/api/nodes/store`, { headers: { cookie: admin.cookie } }, '读取回源前包库',
  );
  check('读取回源前包库', beforeStoreResponse.response.status === 200,
    `HTTP ${beforeStoreResponse.response.status}`);
  const beforeStore = beforeStoreResponse.body;
  check('回源前库里确实没有这个包（否则下面证明不了什么）',
    !beforeStore.packages?.some((p) => p.module === UPSTREAM_PKG));

  const token2 = await accessToken('获取回源安装令牌');

  const upInstall = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token2}`,
    },
    body: JSON.stringify({ module: UPSTREAM_PKG }),
  });
  const upBody = await upInstall.text();
  check('**库里没有的包能从上游下载并装上**（公网无此包 ⇒ 只能来自假上游）',
    upInstall.status >= 200 && upInstall.status < 300,
    `HTTP ${upInstall.status} ${upBody.slice(0, 160)}`);

  const afterStoreResponse = await fetchJson(
    `${B}/api/nodes/store`, { headers: { cookie: admin.cookie } }, '读取回源后包库',
  );
  check('读取回源后包库', afterStoreResponse.response.status === 200,
    `HTTP ${afterStoreResponse.response.status}`);
  const afterStore = afterStoreResponse.body;
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
    headers: { authorization: `Bearer ${token}` },
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
  const inventoryResponse = await fetchJson(
    `${B}/api/nodes/inventory/${ID}`, { headers: { cookie: admin.cookie } }, '读取节点台账',
  );
  check('读取节点台账', inventoryResponse.response.status === 200,
    `HTTP ${inventoryResponse.response.status}`);
  const inv = inventoryResponse.body;
  const okItem = inv.modules?.find((m) => m.module === OK_PKG);
  const platformItem = inv.modules?.find((m) => m.module === PLATFORM_NODE_PACKAGE.name);
  const platformTypes = [...PLATFORM_NODE_TYPES].sort();
  const observedPlatformTypes = [...(platformItem?.types ?? [])].sort();
  const observedNodeSetTypes = (platformItem?.nodeSets ?? [])
    .map((nodeSet) => nodeSet.types?.[0])
    .sort();
  check('台账看得到刚装上的节点，且判为合规', okItem?.compliance === 'approved',
    `实际 ${JSON.stringify(okItem ?? null)}`);
  check('固定 Edge 在真实 bootstrap 后精确加载且判为 platform',
    platformItem?.compliance === 'platform'
      && platformItem.source === 'npm'
      && platformItem.local === true
      && platformItem.version === PLATFORM_NODE_PACKAGE.version
      && platformItem.observedVersions?.length === 1
      && platformItem.observedVersions[0] === PLATFORM_NODE_PACKAGE.version
      && platformItem.health === 'healthy'
      && platformItem.enabled === true
      && platformItem.errors?.length === 0
      && JSON.stringify(observedPlatformTypes) === JSON.stringify(platformTypes)
      && platformItem.nodeSets?.length === PLATFORM_NODE_TYPES.length
      && JSON.stringify(observedNodeSetTypes) === JSON.stringify(platformTypes)
      && platformItem.nodeSets.every((nodeSet) => (
        nodeSet.module === PLATFORM_NODE_PACKAGE.name
        && nodeSet.version === PLATFORM_NODE_PACKAGE.version
        && nodeSet.types?.length === 1
        && PLATFORM_NODE_TYPES.includes(nodeSet.types[0])
        && nodeSet.id === `${PLATFORM_NODE_PACKAGE.name}/${nodeSet.types[0]}`
        && nodeSet.name === nodeSet.types[0]
        && nodeSet.enabled === true
        && nodeSet.err === ''
      )),
    `实际 ${JSON.stringify(platformItem ?? null).slice(0, 180)}`);
  check('common 只作为 Edge 依赖存在，不进入 Node-RED 台账',
    !inv.modules?.some((m) => m.module === PLATFORM_COMMON_PACKAGE.name));
  check('台账把镜像自带的节点判为 builtin',
    inv.modules?.find((m) => m.module === 'node-red')?.compliance === 'builtin');
  check('台账此刻没有未批准项', inv.unapproved === 0, `unapproved=${inv.unapproved}`);

  // 撤销批准 → 已装的那个立刻变成「未批准」，这就是漂移检测
  const revokedOk = await fetchJson(`${B}/api/nodes/catalog/${encodeURIComponent(OK_PKG)}`, {
    method: 'DELETE', headers: H(admin),
  }, `撤销 ${OK_PKG}`);
  check(`撤销 ${OK_PKG}`,
    revokedOk.response.status === 200 && revokedOk.body.ok === true,
    `HTTP ${revokedOk.response.status}`);
  const inventoryAfterRevoke = await fetchJson(
    `${B}/api/nodes/inventory/${ID}`,
    { headers: { cookie: admin.cookie } },
    '撤销后读取节点台账',
  );
  check('撤销后读取节点台账', inventoryAfterRevoke.response.status === 200,
    `HTTP ${inventoryAfterRevoke.response.status}`);
  const inv2 = inventoryAfterRevoke.body;
  check('撤销批准后台账把已装的那个标为未批准（发现清单与实际的漂移）',
    inv2.unapproved === 1
    && inv2.modules.find((m) => m.module === OK_PKG)?.compliance === 'unapproved',
    `unapproved=${inv2.unapproved}`);

  // 另一个也撤掉；UPSTREAM_PKG 仍获批准，固定 Edge 也不可撤销。
  const revokedUrlDep = await fetchJson(`${B}/api/nodes/catalog/${encodeURIComponent(URLDEP_PKG)}`, {
    method: 'DELETE', headers: H(admin),
  }, `撤销 ${URLDEP_PKG}`);
  check(`撤销 ${URLDEP_PKG}`,
    revokedUrlDep.response.status === 200 && revokedUrlDep.body.ok === true,
    `HTTP ${revokedUrlDep.response.status}`);

  // ── 7. 下发策略：重写 settings 并重启 ─────────────
  const appliedResponse = await fetchJson(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  }, '下发收紧后的节点策略');
  const applied = appliedResponse.body;
  check('下发策略到实例并重启',
    appliedResponse.response.status === 200
      && applied.results?.[0]?.ok === true
      && applied.results[0].restarted === true,
    JSON.stringify(applied.results?.[0] ?? null));

  await sleep(3000);
  check('收紧策略下发后实例重新就绪', await ready());
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
  const openedResponse = await fetchJson(`${B}/api/nodes/apply`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ instances: [ID] }),
  }, '下发 open 节点策略');
  const opened = openedResponse.body;
  check('切到 open 后下发策略并重启实例',
    openedResponse.response.status === 200
      && opened.results?.[0]?.ok === true
      && opened.results[0].restarted === true,
    JSON.stringify(opened.results?.[0] ?? null));

  await sleep(3000);
  check('open 策略下发后实例重新就绪', await ready());
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

  const token3 = await accessToken('获取 open 安装令牌');
  const openInstall = await fetch(`http://127.0.0.1:${NR_PORT}/red/${ID}/nodes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token3}`,
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
    failFast = false;
    if (server) {
      try {
        await server.close();
      } catch (error) {
        check('Manager verifier listener 关闭', false, error.message);
      }
    }
    await closeHttpServer(upstreamServer).catch((error) => {
      check('假上游监听关闭', false, error.message);
    });
    if (nodeStore) {
      try {
        const expectedModules = [
          PLATFORM_NODE_PACKAGE.name,
          PLATFORM_COMMON_PACKAGE.name,
          ...GENERIC_FIXTURE_PACKAGES,
        ].sort();
        check('随机 store 只含两个固定根与五个精确命名夹具',
          JSON.stringify(nodeStore.modules()) === JSON.stringify(expectedModules));
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
