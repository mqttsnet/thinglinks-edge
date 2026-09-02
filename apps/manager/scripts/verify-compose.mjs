/**
 * docker-compose 部署验证 —— 只验 compose 这一层特有的风险，
 * 实例生命周期与反代已由 verify-container.mjs 覆盖，不重复。
 *
 * compose 特有的坑：
 *   · 必填变量缺失时应当**拒绝启动**，而不是带着空值跑起来
 *   · 容器 hostname 不是容器名，MANAGER_CONTAINER 若依赖回退，
 *     换个编排方式就会接入失败 —— 表现是反代 502、健康页应用层不通，
 *     而 Manager 本身「看起来正常」
 *   · read_only 根文件系统开启后进程仍须能正常读写数据目录
 *   · Manager 不得再挂宿主 docker.sock，所有 docker 调用必须经受限代理，
 *     且代理的白名单要「够用又不多给」—— 够用由整条生命周期跑通反证，
 *     不多给由逐条探测被拒的端点正面证明
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import Docker from 'dockerode';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 12);
const RUN_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-run';
const ROLE_LABEL = 'com.mqttsnet.thinglinks-edge.verifier-role';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const REVIEWED_MANAGER_IMAGE = process.env.MANAGER_IMAGE?.trim() ?? '';
const PROXY_IMAGE = process.env.PROXY_IMAGE?.trim() || 'wollomatic/socket-proxy:1.13.1';
const NODE_IMAGE = 'nodered/node-red:5.0.4-24-minimal';
const PROJECT = `tle-compose-${RUN_ID}`;
/*
 * 用独立的名字前缀，好让验证能在「现场栈正开着」时照跑。
 * compose 的 container_name 是固定值，不参数化就会撞名 ——
 * 而「跑验证前要先停掉现场」是个不该存在的约束。
 */
const PREFIX = `tle-cv-${RUN_ID}`;
const MGR = `${PREFIX}-manager`;
const PROXY = `${PREFIX}-docker-proxy`;
const INIT = `${PREFIX}-init-data`;
const GID_HELPER = `${PREFIX}-socket-gid`;
const NET = `tle-cv-net-${RUN_ID}`;
/** 首次设置时现场指定的口令。这一串**不该出现在任何日志里** */
const SETUP_PW = `Aa1!${randomBytes(20).toString('base64url')}`;
const MASTER_KEY = randomBytes(48).toString('base64url');
const ID = `cva${RUN_ID}`;
const BROKEN_ID = `cvb${RUN_ID}`;
const TAG = '5.0.4-24-minimal';
const CANONICAL_TMP_PARENT = realpathSync(existsSync('/private/tmp') ? '/private/tmp' : '/tmp');
assert.ok(CANONICAL_TMP_PARENT === '/private/tmp' || CANONICAL_TMP_PARENT === '/tmp');

let PORT;
let HEALTHY_PORT;
let BROKEN_PORT;
let B;
let RUN_ROOT;
let OWNER_FILE;
let TEST_EDGE_ROOT;
let TEST_DATA_ROOT;
let envFile;
let overrideFile;
let managerImageId;
let proxyImageId;
let initImageId;
let nodeImageId;
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
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', cwd: REPO, ...opts });

/*
 * 调用方必须先构建并提供已审查的 MANAGER_IMAGE。本脚本加载部署主文件和
 * 一个只调整随机测试数据根权限的临时覆盖（没有 build/image 字段），把解析后的
 * 不可变 image ID 写入隔离 env，并始终 `up --no-build`：既不会静默拉线上镜像，
 * 也不会在回归中覆盖任何共享 tag 或写 Buildx 元数据。
 */
const composeEnvironment = () => {
  const env = { ...process.env };
  for (const key of [
    'EXTERNAL_URL', 'MASTER_KEY', 'DOCKER_GID', 'BIND_ADDR', 'HOST_PORT',
    'INSTANCE_NETWORK', 'ALLOWED_IMAGE_TAGS', 'EDGE_DATA_ROOT', 'EDGE_NAME_PREFIX',
    'INSTANCE_PORT_MIN', 'INSTANCE_PORT_MAX', 'EDGE_NODE_INSTALL_POLICY',
    'EDGE_NPM_UPSTREAM', 'MANAGER_IMAGE', 'PROXY_IMAGE', 'INIT_IMAGE',
  ]) delete env[key];
  if (managerImageId) env.MANAGER_IMAGE = managerImageId;
  if (proxyImageId) env.PROXY_IMAGE = proxyImageId;
  if (initImageId) env.INIT_IMAGE = initImageId;
  return env;
};
const compose = (...args) => sh(
  [
    'compose', '-p', PROJECT,
    '-f', 'docker-compose.yml', '-f', overrideFile,
    '--env-file', envFile, ...args,
  ],
  { stdio: 'pipe', env: composeEnvironment() },
);

async function socketGid() {
  const gid = sh([
    'run', '--name', GID_HELPER,
    '--label', `${RUN_LABEL}=${RUN_ID}`, '--label', `${INSTANCE_LABEL}=${ID}`,
    '--label', `${ROLE_LABEL}=socket-gid`, '--user', '0:0', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
    managerImageId, 'stat', '-c', '%g', '/var/run/docker.sock',
  ]).trim();
  await captureContainer(GID_HELPER, verifyLabels('socket-gid', ID));
  await removeExactContainer(GID_HELPER, (info) => {
    assert.ok(hasLabels(info.Config?.Labels, verifyLabels('socket-gid', ID)));
  });
  assert.match(gid, /^\d+$/);
  return gid;
}

const isDockerNotFound = (error) => error?.statusCode === 404;
const isFsNotFound = (error) => error?.code === 'ENOENT';
const hasLabels = (actual, expected) => Object.entries(expected)
  .every(([key, value]) => actual?.[key] === value);
const verifyLabels = (role, instanceId) => ({
  [RUN_LABEL]: RUN_ID, [INSTANCE_LABEL]: instanceId, [ROLE_LABEL]: role,
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
  RUN_ROOT = await realpath(await mkdtemp(join(CANONICAL_TMP_PARENT, `tle-compose-${RUN_ID}-`)));
  assert.equal(dirname(RUN_ROOT), CANONICAL_TMP_PARENT);
  assert.ok(basename(RUN_ROOT).startsWith(`tle-compose-${RUN_ID}-`));
  OWNER_FILE = join(RUN_ROOT, '.verifier-owner');
  envFile = join(RUN_ROOT, '.env');
  overrideFile = join(RUN_ROOT, 'compose.verify.json');
  TEST_EDGE_ROOT = join(RUN_ROOT, 'edge-data');
  TEST_DATA_ROOT = join(TEST_EDGE_ROOT, 'instances');
  await mkdir(TEST_EDGE_ROOT, { mode: 0o700 });
  await chmod(TEST_EDGE_ROOT, 0o777);
  writeFileSync(OWNER_FILE, RUN_ID, { flag: 'wx', mode: 0o600 });
  writeFileSync(overrideFile, `${JSON.stringify({
    services: {
      'init-data': {
        command: [
          'sh', '-c',
          'mkdir -p /data-root/manager /data-root/instances'
            + ' && chown -R 1000:1000 /data-root'
            + ' && chmod 0777 /data-root /data-root/manager /data-root/instances',
        ],
      },
    },
  })}\n`, { flag: 'wx', mode: 0o600 });
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
  assert.ok(basename(RUN_ROOT).startsWith(`tle-compose-${RUN_ID}-`));
  const owner = await lstat(OWNER_FILE);
  assert.ok(owner.isFile() && !owner.isSymbolicLink());
  assert.equal(await readFile(OWNER_FILE, 'utf8'), RUN_ID);
  await rm(RUN_ROOT, { recursive: true, force: false });
  await requirePathAbsent(RUN_ROOT, 'compose verifier root');
  RUN_ROOT = undefined;
}

async function resolveImage(reference, label) {
  if (!reference) throw new Error(`${label} requires an explicit image reference`);
  const info = await inspectOrAbsent(raw.getImage(reference));
  if (!info) throw new Error(`${label} image is not present: ${reference}`);
  assert.match(info.Id, /^sha256:[a-f0-9]{64}$/);
  return info.Id;
}

const composeContainers = () => raw.listContainers({
  all: true, filters: { label: [`${COMPOSE_PROJECT_LABEL}=${PROJECT}`] },
});
const composeNetworks = () => raw.listNetworks({
  filters: { label: [`${COMPOSE_PROJECT_LABEL}=${PROJECT}`] },
});
const verifyContainers = () => raw.listContainers({
  all: true, filters: { label: [`${RUN_LABEL}=${RUN_ID}`] },
});
const verifyNetworks = () => raw.listNetworks({
  filters: { label: [`${RUN_LABEL}=${RUN_ID}`] },
});
const managedContainers = async () => (await Promise.all([ID, BROKEN_ID].map((instanceId) => (
  raw.listContainers({
    all: true, filters: { label: [`${MANAGED_LABEL}=true`, `${INSTANCE_LABEL}=${instanceId}`] },
  })
)))).flat();
const managedNetworks = async () => (await Promise.all([ID, BROKEN_ID].map((instanceId) => (
  raw.listNetworks({
    filters: { label: [`${MANAGED_LABEL}=true`, `${INSTANCE_LABEL}=${instanceId}`] },
  })
)))).flat();

async function captureContainer(name, labels) {
  const info = await inspectOrAbsent(raw.getContainer(name));
  assert.ok(info && info.Name === `/${name}` && hasLabels(info.Config?.Labels, labels));
  const recorded = immutableContainerIds.get(name);
  if (recorded) assert.equal(info.Id, recorded, `container id changed for ${name}`);
  immutableContainerIds.set(name, info.Id);
  return info;
}

async function captureNetwork(name, labels) {
  const info = await inspectOrAbsent(raw.getNetwork(name));
  assert.ok(info && info.Name === name && hasLabels(info.Labels, labels));
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

async function cleanupItems(items, kind, verifyOwnership) {
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

async function captureComposeResources() {
  const expected = new Map([[MGR, 'manager'], [PROXY, 'docker-proxy'], [INIT, 'init-data']]);
  for (const [name, service] of expected) {
    await captureContainer(name, {
      [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_SERVICE_LABEL]: service,
    });
  }
  for (const item of await composeNetworks()) {
    const info = await inspectOrAbsent(raw.getNetwork(item.Id));
    assert.ok(info && info.Labels?.[COMPOSE_PROJECT_LABEL] === PROJECT);
    immutableNetworkIds.set(info.Name, info.Id);
  }
}

async function assertComposeOwnership() {
  const services = new Map([[MGR, 'manager'], [PROXY, 'docker-proxy'], [INIT, 'init-data']]);
  for (const [name, service] of services) {
    const id = immutableContainerIds.get(name);
    const info = id ? await inspectOrAbsent(raw.getContainer(id)) : undefined;
    assert.ok(info && info.Name === `/${name}`);
    assert.ok(hasLabels(info.Config?.Labels, {
      [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_SERVICE_LABEL]: service,
    }));
  }
  for (const [name, id] of immutableNetworkIds) {
    if (![`${PREFIX}-docker`, `${PROJECT}_default`].includes(name)) continue;
    const info = await inspectOrAbsent(raw.getNetwork(id));
    assert.ok(info && info.Name === name && info.Labels?.[COMPOSE_PROJECT_LABEL] === PROJECT);
  }
}

async function cleanup() {
  const errors = [];
  const attempt = async (label, task) => {
    try { await task(); } catch (error) { errors.push(`${label}: ${error.message}`); }
  };

  await attempt('compose containers', async () => {
    await cleanupItems(await composeContainers(), 'container', (info) => {
      const service = info.Config?.Labels?.[COMPOSE_SERVICE_LABEL];
      assert.equal(info.Config?.Labels?.[COMPOSE_PROJECT_LABEL], PROJECT);
      assert.ok(['manager', 'docker-proxy', 'init-data'].includes(service));
      assert.equal(info.Name, `/${PREFIX}-${service}`);
    });
    assert.deepEqual(await composeContainers(), []);
  });
  await attempt('managed containers', async () => {
    await cleanupItems(await managedContainers(), 'container', (info) => {
      const instanceId = info.Config?.Labels?.[INSTANCE_LABEL];
      assert.ok([ID, BROKEN_ID].includes(instanceId));
      assert.equal(info.Config?.Labels?.[MANAGED_LABEL], 'true');
      assert.equal(info.Name, `/tle-nr-${instanceId}`);
    });
    assert.deepEqual(await managedContainers(), []);
  });
  await attempt('verifier containers', async () => {
    await cleanupItems(await verifyContainers(), 'container', (info) => {
      assert.equal(info.Config?.Labels?.[RUN_LABEL], RUN_ID);
      assert.ok([ID, BROKEN_ID].includes(info.Config?.Labels?.[INSTANCE_LABEL]));
      assert.ok(['socket-gid', 'foreign-container'].includes(info.Config?.Labels?.[ROLE_LABEL]));
    });
    assert.deepEqual(await verifyContainers(), []);
  });

  await attempt('compose networks', async () => {
    await cleanupItems(await composeNetworks(), 'network', (info) => {
      assert.equal(info.Labels?.[COMPOSE_PROJECT_LABEL], PROJECT);
      assert.ok([`${PREFIX}-docker`, `${PROJECT}_default`].includes(info.Name));
    });
    assert.deepEqual(await composeNetworks(), []);
  });
  await attempt('managed networks', async () => {
    await cleanupItems(await managedNetworks(), 'network', (info) => {
      const instanceId = info.Labels?.[INSTANCE_LABEL];
      assert.ok([ID, BROKEN_ID].includes(instanceId));
      assert.equal(info.Labels?.[MANAGED_LABEL], 'true');
      assert.equal(info.Name, `${NET}-${instanceId}`);
    });
    assert.deepEqual(await managedNetworks(), []);
  });
  await attempt('verifier networks', async () => {
    await cleanupItems(await verifyNetworks(), 'network', (info) => {
      assert.equal(info.Labels?.[RUN_LABEL], RUN_ID);
      assert.ok([ID, BROKEN_ID].includes(info.Labels?.[INSTANCE_LABEL]));
      assert.equal(info.Labels?.[ROLE_LABEL], 'foreign-network');
    });
    assert.deepEqual(await verifyNetworks(), []);
  });
  await attempt('resource ledgers', async () => {
    assert.equal(immutableContainerIds.size, 0);
    assert.equal(immutableNetworkIds.size, 0);
  });
  await attempt('run root', removeRunRoot);
  await attempt('protected baseline', async () => {
    if (protectedBefore) assert.deepEqual(await protectedSnapshot(), protectedBefore);
  });
  if (errors.length) throw new Error(`compose verifier cleanup failed: ${errors.join('; ')}`);
}

async function main() {
  console.log('\n──── docker-compose 部署 · 真实验证 ────\n');
  protectedBefore = await protectedSnapshot();
  [managerImageId, proxyImageId, nodeImageId] = await Promise.all([
    resolveImage(REVIEWED_MANAGER_IMAGE, 'MANAGER_IMAGE'),
    resolveImage(PROXY_IMAGE, 'PROXY_IMAGE'),
    resolveImage(NODE_IMAGE, 'NODE_IMAGE'),
  ]);
  // The reviewed Manager image is Alpine-based, has no ENTRYPOINT override,
  // and is already pinned. Reuse it for the one-shot init service without pulling another tag.
  initImageId = managerImageId;
  [PORT, HEALTHY_PORT, BROKEN_PORT] = await Promise.all([
    allocatePort(), allocatePort(), allocatePort(),
  ]);
  assert.equal(new Set([PORT, HEALTHY_PORT, BROKEN_PORT]).size, 3);
  B = `http://127.0.0.1:${PORT}`;
  await createRunRoot();
  assert.deepEqual(await composeContainers(), []);
  assert.deepEqual(await composeNetworks(), []);
  assert.deepEqual(await verifyContainers(), []);
  assert.deepEqual(await verifyNetworks(), []);
  assert.deepEqual(await managedContainers(), []);
  assert.deepEqual(await managedNetworks(), []);

  /*
   * 必填变量缺失时必须拒绝，而不是带空值起来。
   *
   * 一次只留空一个变量、逐个验：compose 只报**它先撞上的那一个**，
   * 而遍历顺序不稳定 —— 两个都留空时约四分之一的运行会报 MASTER_KEY 而非
   * EXTERNAL_URL。断言写死其中一个名字就会随机翻绿翻红。
   */
  const refusalFor = (missing) => {
    const lines = ['EXTERNAL_URL=http://127.0.0.1:1', 'MASTER_KEY=x']
      .filter((l) => !l.startsWith(`${missing}=`));
    writeFileSync(envFile, lines.join('\n') + `\n${missing}=\n`, { mode: 0o600 });
    try {
      compose('config', '--quiet');
      return null;                                  // 竟然通过了校验
    } catch (e) {
      return String(e.stderr ?? e.message).trim();
    }
  };

  for (const v of ['EXTERNAL_URL', 'MASTER_KEY']) {
    const msg = refusalFor(v);
    check(`缺 ${v} 时 compose 拒绝启动并指名`,
          msg !== null && msg.includes(v),
          msg === null ? '竟然通过了校验' : msg.split('\n')[0].slice(0, 64));
  }

  const dockerGid = await socketGid();
  writeFileSync(envFile, [
    `EXTERNAL_URL=${B}`,
    `MASTER_KEY=${MASTER_KEY}`,
    `MANAGER_IMAGE=${managerImageId}`,
    `PROXY_IMAGE=${proxyImageId}`,
    `INIT_IMAGE=${initImageId}`,
    `DOCKER_GID=${dockerGid}`,
    'BIND_ADDR=127.0.0.1',
    `HOST_PORT=${PORT}`,
    `INSTANCE_NETWORK=${NET}`,
    `ALLOWED_IMAGE_TAGS=${TAG}`,
    `EDGE_DATA_ROOT=${TEST_EDGE_ROOT}`,
    `EDGE_NAME_PREFIX=${PREFIX}`,
    `INSTANCE_PORT_MIN=${Math.min(HEALTHY_PORT, BROKEN_PORT)}`,
    `INSTANCE_PORT_MAX=${Math.max(HEALTHY_PORT, BROKEN_PORT)}`,
    'EDGE_NODE_INSTALL_POLICY=allowlist',
    'EDGE_NPM_UPSTREAM=',
  ].join('\n') + '\n', { mode: 0o600 });

  console.log('  · docker compose up -d --no-build（固定已审查镜像）…');
  compose('up', '-d', '--no-build');
  await captureComposeResources();

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    ready = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('compose 起栈后 Manager 就绪', ready);
  if (!ready) {
    console.log(compose('logs', '--tail', '20', 'manager').split('\n').map((l) => '      ' + l).join('\n'));
    throw new Error('compose 栈未就绪');
  }

  const info = await captureContainer(MGR, {
    [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_SERVICE_LABEL]: 'manager',
  });
  check('compose Manager 使用显式不可变镜像 ID', info.Image === managerImageId);
  check('只读根文件系统已生效', info.HostConfig.ReadonlyRootfs === true);
  check('已禁止提权（no-new-privileges）',
        (info.HostConfig.SecurityOpt ?? []).some((o) => /no-new-privileges/.test(o)));
  // 同名挂载：容器内路径必须等于宿主路径，否则 Manager 写进实例 Binds 的路径
  // 会被宿主 daemon 解析到别处 —— 静默挂错盘
  check('数据根同名挂载（容器内路径 == 宿主路径）',
        (info.Mounts ?? []).some((m) => m.Source === TEST_EDGE_ROOT && m.Destination === TEST_EDGE_ROOT),
        (info.Mounts ?? []).map((m) => `${m.Source}→${m.Destination}`).join(' ') || '无绑定挂载');

  const dbPath = `${TEST_EDGE_ROOT}/manager/edge.db`;
  check('库文件落在宿主数据根上，不在容器可写层',
        (await lstat(dbPath)).isFile(), dbPath);

  // hostname 回退之所以不能依赖：compose 下 hostname 是容器短 id 而非容器名，
  // 一旦部署时显式设了 hostname:，回退拿到的就是个 Docker 不认识的名字
  check('容器 hostname 不等于容器名（故 MANAGER_CONTAINER 必须显式配置）',
        info.Config.Hostname !== MGR, `hostname=${info.Config.Hostname} vs 容器名=${MGR}`);

  /*
   * 首次设置：口令**不再出现在日志里**，由这一步现场指定。
   * 顺带把「日志里没有口令」当成一条断言 —— 那正是这次改造要保住的性质。
   */
  const logs = compose('logs', 'manager');
  check('启动日志里没有任何口令',
        !/初始口令/.test(logs) && !logs.includes(SETUP_PW),
        /\[init\]/.test(logs) ? '有 [init] 行但不含口令' : '');

  const state = await (await fetch(`${B}/api/setup`)).json();
  check('全新部署上匿名读得到「需要首次设置」', state.needed === true, JSON.stringify(state));

  const setupRes = await fetch(`${B}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
  });
  const cookie = (setupRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  check('设置完直接带着会话进去，不必再登录一次',
        setupRes.status === 200 && cookie.includes('tle_sid') && Boolean(csrf),
        `HTTP ${setupRes.status}`);
  const H = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  /*
   * 先登记一个随后损坏的实例，保证启动恢复会先处理它。用同名但错误标签的
   * 网络模拟手工误建/残留：Manager 必须拒绝接入它，同时不能耽误健康实例。
   */
  const brokenCreated = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: BROKEN_ID, name: '损坏网络验证', imageTag: TAG,
                           ports: [{ hostPort: BROKEN_PORT, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT' }] }),
  });
  const brokenDetail = brokenCreated.status === 201 ? '' : (await brokenCreated.text()).slice(0, 160);
  check('先创建将损坏的历史实例', brokenCreated.status === 201,
        `HTTP ${brokenCreated.status}${brokenDetail ? ` ${brokenDetail}` : ''}`);
  const brokenContainer = await captureContainer(`tle-nr-${BROKEN_ID}`, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: BROKEN_ID,
  });
  const brokenNetwork = await captureNetwork(`${NET}-${BROKEN_ID}`, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: BROKEN_ID,
  });
  await removeExactContainer(`tle-nr-${BROKEN_ID}`, (current) => {
    assert.ok(hasLabels(current.Config?.Labels, {
      [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: BROKEN_ID,
    }));
  });
  await raw.getNetwork(brokenNetwork.Id).disconnect({ Container: info.Id, Force: true });
  await removeExactNetwork(`${NET}-${BROKEN_ID}`, (current) => {
    assert.ok(hasLabels(current.Labels, {
      [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: BROKEN_ID,
    }));
  });
  await requireDockerAbsent(raw.getContainer(brokenContainer.Id), 'removed broken container');
  const foreignContainer = await raw.createContainer({
    name: `tle-nr-${BROKEN_ID}`,
    Image: nodeImageId,
    Cmd: ['node', '-e', 'setInterval(() => {}, 1000)'],
    Labels: {
      'com.mqttsnet.thinglinks-edge.managed': 'false',
      'com.mqttsnet.thinglinks-edge.instance': BROKEN_ID,
      [RUN_LABEL]: RUN_ID,
      [ROLE_LABEL]: 'foreign-container',
    },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=8m' },
    },
  });
  const foreignContainerInfo = await captureContainer(`tle-nr-${BROKEN_ID}`, {
    [MANAGED_LABEL]: 'false', [INSTANCE_LABEL]: BROKEN_ID,
    [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'foreign-container',
  });
  assert.equal(foreignContainerInfo.Id, foreignContainer.id);
  await foreignContainer.start();
  const foreignNetwork = await raw.createNetwork({
    Name: `${NET}-${BROKEN_ID}`,
    Driver: 'bridge',
    Internal: true,
    Labels: {
      'com.mqttsnet.thinglinks-edge.managed': 'false',
      'com.mqttsnet.thinglinks-edge.instance': BROKEN_ID,
      [RUN_LABEL]: RUN_ID,
      [ROLE_LABEL]: 'foreign-network',
    },
  });
  const foreignNetworkInfo = await captureNetwork(`${NET}-${BROKEN_ID}`, {
    [MANAGED_LABEL]: 'false', [INSTANCE_LABEL]: BROKEN_ID,
    [RUN_LABEL]: RUN_ID, [ROLE_LABEL]: 'foreign-network',
  });
  assert.equal(foreignNetworkInfo.Id, foreignNetwork.id);

  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: 'compose 验证', imageTag: TAG,
                           ports: [{ hostPort: HEALTHY_PORT, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT' }] }),
  });
  // 失败时把正文带出来 —— 光一个「HTTP 400」在这一步是排不动的
  const createdDetail = created.status === 201 ? '' : (await created.text()).slice(0, 160);
  check('创建实例成功（只读 rootfs 下 SQLite 仍可写）', created.status === 201,
        `HTTP ${created.status}${createdDetail ? ' ' + createdDetail : ''}`);

  const healthyContainer = await captureContainer(`tle-nr-${ID}`, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
  });
  const netInfo = await captureNetwork(`${NET}-${ID}`, {
    [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: ID,
  });
  const attached = Object.values(netInfo.Containers ?? {}).map((c) => c.Name);
  check('MANAGER_CONTAINER 生效：Manager 接入了实例网络', attached.includes(MGR), attached.join(' + '));
  const nodeRedBeforeRecreate = healthyContainer;
  const nodeRedStateBeforeRecreate = {
    id: nodeRedBeforeRecreate.Id,
    status: nodeRedBeforeRecreate.State.Status,
    running: nodeRedBeforeRecreate.State.Running,
    startedAt: nodeRedBeforeRecreate.State.StartedAt,
    restartCount: nodeRedBeforeRecreate.RestartCount,
  };
  // settings.js 是 Manager 下发且实例运行必需的数据；只比哈希，避免验证输出任何凭据。
  const settingsDigestBeforeRecreate = createHash('sha256')
    .update(await readFile(`${TEST_DATA_ROOT}/${ID}/settings.js`)).digest('hex');

  // ── 受限 docker 代理 ────────────────────────────────────
  // 走到这里说明整条生命周期（建网络/建卷/建容器/塞 settings.js/启停/取日志/取 stats）
  // 都已经过代理跑通了 —— 这就是「白名单够用」的反证，不必再逐条正面验。
  const mounts = (info.Mounts ?? []).map((m) => m.Source);
  check('Manager 已不再挂载宿主 docker.sock',
        !mounts.some((m) => String(m).includes('docker.sock')), mounts.join(' ') || '（无绑定挂载）');
  check('Manager 已不需要附加属组',
        (info.HostConfig.GroupAdd ?? []).length === 0, JSON.stringify(info.HostConfig.GroupAdd ?? []));

  const proxyInfo = await captureContainer(PROXY, {
    [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_SERVICE_LABEL]: 'docker-proxy',
  });
  check('特权集中在代理上：只有它挂 socket，且是只读',
        (proxyInfo.Mounts ?? []).some((m) => String(m.Source).includes('docker.sock') && m.RW === false));

  const startupLog = compose('logs', 'manager');
  check('Manager 启动日志确认端点是代理而非裸 socket',
        startupLog.includes(`docker 端点 ${PROXY}:2375（受限代理）`),
        /docker 端点 (.+)$/m.exec(startupLog)?.[1]?.trim() ?? '日志里没有端点信息');

  /** 在某个容器里用 node 的 fetch 探一下代理，返回 'S<状态码>' 或 'X' */
  const probeFrom = (container, path) => {
    const js = `fetch('http://${PROXY}:2375${path}',{signal:AbortSignal.timeout(4000)})`
      + `.then(r=>console.log('S'+r.status)).catch(()=>console.log('X'))`;
    try { return sh(['exec', container, 'node', '-e', js]).trim(); } catch { return 'X'; }
  };

  check('代理放行 Manager 真正要用的端点', probeFrom(MGR, '/version') === 'S200', probeFrom(MGR, '/version'));

  /*
   * `/info` 是**刻意放行**的（dc2cc90）：安装自检的「架构与镜像匹配」
   * 「cgroup 内存限制」两项只能从这里读，缺了它们现场发现不了
   * 「内存限额配了但不生效」——那种故障界面上一切正常，实例却能吃光整机内存。
   * 它是纯只读的守护进程元信息，敏感度低于白名单里已有的 containers/json。
   */
  check('代理放行只读的 /info（安装自检的架构与 cgroup 两项靠它）',
        probeFrom(MGR, '/info') === 'S200', probeFrom(MGR, '/info'));
  check('代理放行单实例网络 inspect（恢复时核验网络归属）',
        probeFrom(MGR, `/networks/${NET}-${ID}`) === 'S200',
        probeFrom(MGR, `/networks/${NET}-${ID}`));

  const denied = ['/events', '/swarm', '/secrets', '/plugins'];
  const denyResults = denied.map((p) => `${p}=${probeFrom(MGR, p)}`);
  check('代理拒绝白名单外的端点',
        denyResults.every((r) => r.endsWith('=S403')), denyResults.join(' '));

  const execDenied = (() => {
    const js = `fetch('http://${PROXY}:2375/containers/${MGR}/exec',{method:'POST',`
      + `signal:AbortSignal.timeout(4000)}).then(r=>console.log('S'+r.status)).catch(()=>console.log('X'))`;
    try { return sh(['exec', MGR, 'node', '-e', js]).trim(); } catch { return 'X'; }
  })();
  check('代理拒绝 exec —— 拿到 Manager 也开不了容器内的壳', execDenied === 'S403', execDenied);

  // 实例各有各的网络，代理只在 edge-docker 上，实例根本够不到
  const fromInstance = probeFrom(`tle-nr-${ID}`, '/version');
  check('实例容器够不到代理（网络上就不通）', fromInstance === 'X', fromInstance);

  let editor = 0;
  for (let i = 0; i < 40 && editor !== 200; i++) {
    await sleep(1000);
    editor = await fetch(`${B}/red/${ID}/`, { headers: { cookie }, redirect: 'manual' })
      .then((r) => r.status).catch(() => 0);
  }
  check('打开编辑器可用（反代按容器名解析到实例）', editor === 200, `HTTP ${editor}`);

  /*
   * 复现已运行实例的关键场景：部署升级或运维修复可能只 force-recreate
   * Manager，实例容器和数据根则必须原样保留。若新 Manager 没有重新加入
   * 实例专属网络，/red/:id/sso 会因反代无法解析实例而变成 502。
  */
  const managerBeforeRecreate = (await raw.getContainer(MGR).inspect()).Id;
  compose('up', '-d', '--no-build', '--force-recreate', '--no-deps', 'manager');

  let recreatedReady = false;
  for (let i = 0; i < 40 && !recreatedReady; i++) {
    await sleep(500);
    recreatedReady = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('只重建 Manager 后仍就绪', recreatedReady);

  await requireDockerAbsent(raw.getContainer(managerBeforeRecreate), 'replaced Manager id');
  immutableContainerIds.delete(MGR);
  const managerAfterRecreate = await captureContainer(MGR, {
    [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_SERVICE_LABEL]: 'manager',
  });
  check('只重建 Manager 确实替换了容器',
        managerAfterRecreate.Id !== managerBeforeRecreate
          && managerAfterRecreate.Image === managerImageId);

  const recreatedNet = await raw.getNetwork(`${NET}-${ID}`).inspect();
  const recreatedAttached = Object.values(recreatedNet.Containers ?? {}).map((c) => c.Name);
  check('重建后的 Manager 重新接入实例网络', recreatedAttached.includes(MGR),
        recreatedAttached.join(' + '));

  const nodeRedAfterRecreate = await raw.getContainer(`tle-nr-${ID}`).inspect();
  const nodeRedStateAfterRecreate = {
    id: nodeRedAfterRecreate.Id,
    status: nodeRedAfterRecreate.State.Status,
    running: nodeRedAfterRecreate.State.Running,
    startedAt: nodeRedAfterRecreate.State.StartedAt,
    restartCount: nodeRedAfterRecreate.RestartCount,
  };
  check('重建 Manager 不重启健康实例',
        JSON.stringify(nodeRedStateAfterRecreate) === JSON.stringify(nodeRedStateBeforeRecreate));
  const settingsDigestAfterRecreate = createHash('sha256')
    .update(await readFile(`${TEST_DATA_ROOT}/${ID}/settings.js`)).digest('hex');
  check('重建 Manager 不改实例持久化 settings 数据',
        settingsDigestAfterRecreate === settingsDigestBeforeRecreate);

  const impostor = await raw.getNetwork(`${NET}-${BROKEN_ID}`).inspect();
  const impostorMembers = Object.values(impostor.Containers ?? {}).map((c) => c.Name);
  check('重建 Manager 不接入同名错误归属网络', !impostorMembers.includes(MGR), impostorMembers.join(' + ') || '无成员');

  // Manager 重建会令旧会话失效；重新登录后再测 SSO，避免把会话语义误判成网络回归。
  const reloginRes = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
  });
  const recreatedCookie = (reloginRes.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).join('; ');
  const recreatedCsrf = /tle_csrf=([^;]+)/.exec(recreatedCookie)?.[1] ?? '';
  check('重建 Manager 后重新登录成功并取得新会话',
        reloginRes.status === 200 && recreatedCookie.includes('tle_sid') && Boolean(recreatedCsrf),
        `HTTP ${reloginRes.status}`);
  const ssoAfterRecreate = await fetch(`${B}/red/${ID}/sso`, {
    headers: { cookie: recreatedCookie }, redirect: 'manual',
  }).then((r) => r.status).catch(() => 0);
  check('重建 Manager 后重新登录访问实例 SSO 仍成功', ssoAfterRecreate === 200,
        `HTTP ${ssoAfterRecreate}`);

  // 同一容器仍在网络中时重启，覆盖 connect 的幂等路径而不重建 Manager 容器。
  compose('restart', 'manager');
  let restartedReady = false;
  for (let i = 0; i < 40 && !restartedReady; i++) {
    await sleep(500);
    restartedReady = await fetch(`${B}/healthz`).then((r) => r.ok).catch(() => false);
  }
  check('已接入网络的 Manager 重启后仍就绪', restartedReady);
  const restartedNet = await raw.getNetwork(`${NET}-${ID}`).inspect();
  check('已接入网络的 Manager 重启不重复或断开端点',
        Object.values(restartedNet.Containers ?? {}).map((c) => c.Name).includes(MGR));
  const restartedLogin = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
  });
  const restartedCookie = (restartedLogin.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).join('; ');
  const restartedCsrf = /tle_csrf=([^;]+)/.exec(restartedCookie)?.[1] ?? '';
  check('Manager 重启后重新登录成功',
    restartedLogin.status === 200 && restartedCookie.includes('tle_sid') && Boolean(restartedCsrf),
    `HTTP ${restartedLogin.status}`);
  const ssoAfterRestart = await fetch(`${B}/red/${ID}/sso`, {
    headers: { cookie: restartedCookie }, redirect: 'manual',
  }).then((r) => r.status).catch(() => 0);
  check('已接入网络的 Manager 重启后实例 SSO 仍成功', ssoAfterRestart === 200,
        `HTTP ${ssoAfterRestart}`);

  const restartedH = {
    cookie: restartedCookie, 'x-csrf-token': restartedCsrf, 'content-type': 'application/json',
  };
  const brokenDeleted = await fetch(`${B}/api/instances/${BROKEN_ID}`, { method: 'DELETE', headers: restartedH });
  const healthyDeleted = await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: restartedH });
  check('删除健康实例返回 204', healthyDeleted.status === 204,
        `HTTP ${healthyDeleted.status}`);

  // 必须在兜底 cleanup 之前核对真实 Docker 状态，否则 remove() 吞掉清理错误也会假绿。
  const healthyContainerAfterDelete = await inspectOrAbsent(raw.getContainer(healthyContainer.Id));
  const healthyContainerNameAfterDelete = await inspectOrAbsent(raw.getContainer(`tle-nr-${ID}`));
  const healthyNetworkAfterDelete = await inspectOrAbsent(raw.getNetwork(netInfo.Id));
  const healthyNetworkNameAfterDelete = await inspectOrAbsent(raw.getNetwork(`${NET}-${ID}`));
  check('删除健康实例后容器已不存在',
    healthyContainerAfterDelete === undefined && healthyContainerNameAfterDelete === undefined);
  check('删除健康实例后网络已不存在',
    healthyNetworkAfterDelete === undefined && healthyNetworkNameAfterDelete === undefined);
  immutableContainerIds.delete(`tle-nr-${ID}`);
  immutableNetworkIds.delete(`${NET}-${ID}`);

  const afterDeleteListRes = await fetch(`${B}/api/instances`, {
    headers: { cookie: restartedCookie },
  });
  const afterDeleteList = await afterDeleteListRes.json().catch(() => ({}));
  const afterDeleteIds = Array.isArray(afterDeleteList.instances)
    ? afterDeleteList.instances.map((instance) => instance.id)
    : [];
  check('删除后实例列表不再包含健康或损坏实例记录',
        afterDeleteListRes.status === 200
          && Array.isArray(afterDeleteList.instances)
          && !afterDeleteIds.includes(ID)
          && !afterDeleteIds.includes(BROKEN_ID),
        `HTTP ${afterDeleteListRes.status}; IDs=${afterDeleteIds.join(',') || '空'}`);

  const impostorAfterDelete = await inspectOrAbsent(raw.getNetwork(`${NET}-${BROKEN_ID}`));
  const foreignContainerAfterDelete = await inspectOrAbsent(raw.getContainer(`tle-nr-${BROKEN_ID}`));
  check('删除损坏实例只删数据库记录，冒名容器和网络仍保留',
        brokenDeleted.status === 204
          && foreignContainerAfterDelete?.Config.Labels?.['com.mqttsnet.thinglinks-edge.managed'] === 'false'
          && impostorAfterDelete?.Labels?.['com.mqttsnet.thinglinks-edge.managed'] === 'false',
        `HTTP ${brokenDeleted.status}`);
  await removeExactContainer(`tle-nr-${BROKEN_ID}`, (current) => {
    assert.ok(hasLabels(current.Config?.Labels, verifyLabels('foreign-container', BROKEN_ID)));
    assert.equal(current.Config?.Labels?.[MANAGED_LABEL], 'false');
  });
  await removeExactNetwork(`${NET}-${BROKEN_ID}`, (current) => {
    assert.ok(hasLabels(current.Labels, verifyLabels('foreign-network', BROKEN_ID)));
    assert.equal(current.Labels?.[MANAGED_LABEL], 'false');
  });

  await assertComposeOwnership();
  compose('down', '-v');
  for (const name of [MGR, PROXY, INIT]) {
    const id = immutableContainerIds.get(name);
    assert.ok(id);
    await requireDockerAbsent(raw.getContainer(id), `compose container ${id}`);
    await requireDockerAbsent(raw.getContainer(name), `compose container name ${name}`);
    immutableContainerIds.delete(name);
  }
  for (const [name, id] of [...immutableNetworkIds]) {
    if (![`${PREFIX}-docker`, `${PROJECT}_default`].includes(name)) continue;
    await requireDockerAbsent(raw.getNetwork(id), `compose network ${id}`);
    await requireDockerAbsent(raw.getNetwork(name), `compose network name ${name}`);
    immutableNetworkIds.delete(name);
  }
  check('compose down -v 清理干净',
    (await composeContainers()).length === 0 && (await composeNetworks()).length === 0);

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
