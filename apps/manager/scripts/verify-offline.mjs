#!/usr/bin/env node

/**
 * 离线安装包验证（T6.3）。
 *
 * CI 入口已经生成并精确校验过一个当前 checkout 的 offline bundle。本脚本优先
 * 安装那个 provided exact artifact，避免在验收阶段悄悄另打一份包、把「制品通过」
 * 降级成「另一份临时产物通过」。直接单跑时才走 standalone fallback：给平台镜像
 * 建本次调用独享的假仓库 tag，再生成一个最小种子包，证明安装没有回源。
 *
 * Docker Desktop 往往由多个项目共享。这里所有容器、网络、镜像别名和数据目录都
 * 使用不可预测的调用级名称；启动前只读拒绝同名，清理前复核 name + immutable ID
 * + ownership labels，最后固定到 ID 删除。绝不清共享 TLE_VERIFY_EDGE_ROOT，也绝不
 * 以固定 tle-off* 名称扫删宿主资源。
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import Docker from 'dockerode';

import { tarArchive } from '../dist/core/archive/tar.js';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from '../dist/core/nodes/platform-contract.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERIFY_BUNDLE = join(REPO, 'apps/manager/scripts/verify-offline-bundle.mjs');
const SETUP_PW = 'offline-verify-pass-01';
const STANDALONE_TAG = '5.0.4-24-minimal';
const SEED_BASE = 'node-red-contrib-tle-offline-seed';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_NETWORK_LABEL = 'com.docker.compose.network';
const MANAGED_LABEL = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE_LABEL = 'com.mqttsnet.thinglinks-edge.instance';
const IMMUTABLE_ID = /^(?:sha256:)?[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const SAFE_TOKEN = /^[a-f0-9]{12}$/;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const command = (cmd, args, options = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  cwd: REPO,
  maxBuffer: 64 * 1024 * 1024,
  ...options,
});

export function seededApprovalContract(mode, packages) {
  if (mode === 'fallback') return packages.every((item) => item.approved === false);
  if (mode !== 'provided') return false;
  const edge = packages.find((item) => item.module === PLATFORM_NODE_PACKAGE.name);
  const common = packages.find((item) => item.module === PLATFORM_COMMON_PACKAGE.name);
  return edge?.approved === true
    && common?.approved === false
    && packages.every((item) => (
      item.module === PLATFORM_NODE_PACKAGE.name || item.approved === false
    ));
}

export function createInvocationIdentity({
  outerRunId = process.env.TLE_VERIFY_RUN_ID?.trim() || '',
  randomToken = randomBytes(6).toString('hex'),
} = {}) {
  if (!SAFE_TOKEN.test(randomToken)) throw new Error('invalid offline verifier random token');
  const runId = outerRunId || `local-${randomToken}`;
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid offline verifier run id: ${runId}`);
  const scope = createHash('sha256')
    .update(`${runId}\0${randomToken}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = `tle-off-${scope}`;
  const instanceId = `off-${scope}`;
  return Object.freeze({
    runId,
    invocation: randomToken,
    scope,
    prefix,
    project: `tle-offline-${scope}`,
    instanceId,
    rejectedInstanceId: `offb-${scope}`,
    instanceNetworkBase: `${prefix}-net`,
    instanceNetwork: `${prefix}-net-${instanceId}`,
    composeNetwork: `${prefix}-docker`,
    defaultComposeNetwork: `tle-offline-${scope}_default`,
    managerName: `${prefix}-manager`,
    proxyName: `${prefix}-docker-proxy`,
    initName: `${prefix}-init-data`,
    instanceName: `tle-nr-${instanceId}`,
    seedPackage: `${SEED_BASE}-${scope}`,
    fakeImages: Object.freeze({
      manager: `tle-offline-verify.invalid/${scope}/manager:probe`,
      proxy: `tle-offline-verify.invalid/${scope}/socket-proxy:probe`,
      init: `tle-offline-verify.invalid/${scope}/init:probe`,
    }),
    ownerText: `${runId}\n${randomToken}\n`,
  });
}

export function resolveCanonicalTempParent(adapters = {}) {
  const pathExists = adapters.existsSync ?? existsSync;
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const candidate = pathExists('/private/tmp') ? '/private/tmp' : '/tmp';
  const canonical = canonicalize(candidate);
  if (canonical !== '/private/tmp' && canonical !== '/tmp') {
    throw new Error(`canonical temp parent escapes allowed boundary: ${canonical}`);
  }
  return canonical;
}

export function assertOwnedTempArea(area, adapters = {}) {
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const inspect = adapters.lstatSync ?? lstatSync;
  const read = adapters.readFileSync ?? readFileSync;
  const canonical = canonicalize(area.path);
  if (canonical !== area.path) throw new Error(`temporary path changed: ${area.path}`);
  if (!area.path.startsWith(`${area.parent}${sep}${area.prefix}`)) {
    throw new Error(`temporary path escaped owned prefix: ${area.path}`);
  }
  const rel = relative(area.parent, area.path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`temporary path escaped canonical parent: ${area.path}`);
  }
  const rootStat = inspect(area.path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`temporary root changed type: ${area.path}`);
  }
  const markerStat = inspect(area.marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error(`temporary ownership marker changed: ${area.marker}`);
  }
  if (read(area.marker, 'utf8') !== area.ownerText) {
    throw new Error(`temporary ownership marker changed owner: ${area.marker}`);
  }
  return true;
}

export function createOwnedTempArea(identity, role, adapters = {}) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(role)) throw new Error(`invalid temp role: ${role}`);
  const parent = resolveCanonicalTempParent(adapters);
  const prefix = `tle-${role}-${identity.scope}.`;
  const make = adapters.mkdtempSync ?? mkdtempSync;
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const write = adapters.writeFileSync ?? writeFileSync;
  const path = canonicalize(make(join(parent, prefix)));
  const marker = join(path, `.tle-offline-owner-${identity.invocation}`);
  write(marker, identity.ownerText, { flag: 'wx', mode: 0o600 });
  const area = Object.freeze({ path, parent, prefix, marker, ownerText: identity.ownerText });
  assertOwnedTempArea(area, adapters);
  return area;
}

export function removeOwnedTempArea(area, adapters = {}) {
  assertOwnedTempArea(area, adapters);
  const remove = adapters.rmSync ?? rmSync;
  const pathExists = adapters.existsSync ?? existsSync;
  remove(area.path, { recursive: true, force: false });
  if (pathExists(area.path)) throw new Error(`owned temporary path still exists: ${area.path}`);
}

function dockerHandle(raw, kind, ref) {
  return kind === 'container' ? raw.getContainer(ref) : raw.getNetwork(ref);
}

async function inspectOrAbsent(handle) {
  try {
    return await handle.inspect();
  } catch (error) {
    if (error?.statusCode === 404) return undefined;
    throw error;
  }
}

function resourceName(info, kind) {
  return kind === 'container' ? String(info?.Name ?? '').replace(/^\//, '') : info?.Name;
}

function resourceLabels(info, kind) {
  return kind === 'container' ? info?.Config?.Labels : info?.Labels;
}

function hasLabels(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

export function assertExactDockerResource(info, expected) {
  if (
    !info
    || !IMMUTABLE_ID.test(String(info.Id ?? ''))
    || resourceName(info, expected.kind) !== expected.name
    || !hasLabels(resourceLabels(info, expected.kind), expected.labels)
  ) {
    throw new Error(`refusing ownership mismatch for ${expected.kind} ${expected.name}`);
  }
  if (expected.id && info.Id !== expected.id) {
    throw new Error(`refusing immutable ID mismatch for ${expected.kind} ${expected.name}`);
  }
  return info;
}

export async function requireDockerNameAbsent(raw, expected) {
  const found = await inspectOrAbsent(dockerHandle(raw, expected.kind, expected.name));
  if (found) throw new Error(`refusing pre-existing ${expected.kind} name: ${expected.name}`);
}

export async function captureDockerResource(raw, ledger, expected, { optional = false } = {}) {
  const info = await inspectOrAbsent(dockerHandle(raw, expected.kind, expected.name));
  if (!info) {
    if (optional) return undefined;
    throw new Error(`expected ${expected.kind} was not created: ${expected.name}`);
  }
  assertExactDockerResource(info, expected);
  const captured = Object.freeze({ ...expected, id: info.Id });
  const previous = ledger.get(expected.name);
  if (previous && previous.id !== captured.id) {
    throw new Error(`captured ${expected.kind} changed ID: ${expected.name}`);
  }
  ledger.set(expected.name, captured);
  return captured;
}

async function removeCapturedDockerResource(raw, captured) {
  const byId = await inspectOrAbsent(dockerHandle(raw, captured.kind, captured.id));
  if (!byId) {
    const replacement = await inspectOrAbsent(dockerHandle(raw, captured.kind, captured.name));
    if (replacement) {
      throw new Error(`refusing same-name replacement for ${captured.kind} ${captured.name}`);
    }
    return;
  }
  assertExactDockerResource(byId, captured);
  const handle = dockerHandle(raw, captured.kind, captured.id);
  if (captured.kind === 'container') {
    await handle.remove({ force: true, v: true });
  } else {
    await handle.remove();
  }
  const remainsById = await inspectOrAbsent(dockerHandle(raw, captured.kind, captured.id));
  if (remainsById) throw new Error(`owned ${captured.kind} still exists: ${captured.id}`);
  const remainsByName = await inspectOrAbsent(dockerHandle(raw, captured.kind, captured.name));
  if (remainsByName) {
    throw new Error(`same-name replacement appeared for ${captured.kind} ${captured.name}`);
  }
}

export async function cleanupTrackedDockerResources(raw, ledger) {
  const failures = [];
  const captured = [...ledger.values()].sort((a, b) => a.cleanupOrder - b.cleanupOrder);
  for (const item of captured) {
    try {
      await removeCapturedDockerResource(raw, item);
      ledger.delete(item.name);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'offline Docker cleanup failed');
}

export async function createTrackedImageAlias(adapters, ledger, sourceRef, alias) {
  if (await adapters.inspect(alias)) throw new Error(`refusing pre-existing image alias: ${alias}`);
  const source = await adapters.inspect(sourceRef);
  if (!source?.Id || !IMMUTABLE_ID.test(source.Id)) {
    throw new Error(`source image is unavailable or mutable: ${sourceRef}`);
  }
  await adapters.tag(source.Id, alias);
  ledger.set(alias, source.Id);
  const tagged = await adapters.inspect(alias);
  if (!tagged || tagged.Id !== source.Id) throw new Error(`image alias changed during tag: ${alias}`);
  return source.Id;
}

export async function cleanupTrackedImageAliases(adapters, ledger) {
  const failures = [];
  for (const [alias, expectedId] of [...ledger.entries()].reverse()) {
    try {
      const current = await adapters.inspect(alias);
      if (!current) {
        ledger.delete(alias);
        continue;
      }
      if (current.Id !== expectedId) throw new Error(`refusing repointed image alias: ${alias}`);
      await adapters.remove(alias);
      if (await adapters.inspect(alias)) throw new Error(`image alias still exists: ${alias}`);
      ledger.delete(alias);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'offline image-alias cleanup failed');
}

export async function selectBundleSource({ providedBundle, validateProvided, buildFallback }) {
  if (providedBundle?.trim()) {
    return { mode: 'provided', bundle: validateProvided(providedBundle.trim()) };
  }
  return { mode: 'fallback', bundle: await buildFallback() };
}

function safeArchiveEntry(entry) {
  const first = entry.split('/')[0];
  return entry.length > 0
    && !entry.startsWith('/')
    && !/[\0\r\n]/.test(entry)
    && first.length > 0
    && !first.startsWith('-')
    && !entry.split('/').includes('..');
}

function validateRegularFile(path, label) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return realpathSync(resolved);
}

function readBundleManifest(bundle) {
  const entries = command('tar', ['-tzf', bundle]).trim().split('\n').filter(Boolean);
  if (!entries.length || !entries.every(safeArchiveEntry)) throw new Error('bundle has unsafe paths');
  const manifests = entries.filter((entry) => entry.endsWith('/manifest.json'));
  if (manifests.length !== 1) throw new Error('bundle must contain exactly one manifest.json');
  const manifestText = command('tar', ['-xOf', bundle, '--', manifests[0]], { maxBuffer: 4 * 1024 * 1024 });
  const manifest = JSON.parse(manifestText);
  if (!Array.isArray(manifest.images) || manifest.images.length < 4) {
    throw new Error('bundle manifest images missing');
  }
  const manager = manifest.images[0];
  command(process.execPath, [VERIFY_BUNDLE, bundle, manager.image, manager.id], {
    stdio: 'pipe',
    env: { ...process.env },
  });
  return manifest;
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    if (!/^[A-Z0-9_]+=/.test(line)) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (values.has(key)) throw new Error(`duplicate .env key: ${key}`);
    values.set(key, line.slice(at + 1));
  }
  return values;
}

function allocatePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('unable to allocate offline verifier port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

export function expectedDockerResources(identity) {
  const composeContainer = (name, service, cleanupOrder) => ({
    kind: 'container', name, cleanupOrder,
    labels: {
      [COMPOSE_PROJECT_LABEL]: identity.project,
      [COMPOSE_SERVICE_LABEL]: service,
    },
  });
  return [
    composeContainer(identity.managerName, 'manager', 20),
    composeContainer(identity.proxyName, 'docker-proxy', 21),
    composeContainer(identity.initName, 'init-data', 22),
    {
      kind: 'container', name: identity.instanceName, cleanupOrder: 10,
      labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: identity.instanceId },
    },
    {
      kind: 'network', name: identity.instanceNetwork, cleanupOrder: 30,
      labels: { [MANAGED_LABEL]: 'true', [INSTANCE_LABEL]: identity.instanceId },
    },
    {
      kind: 'network', name: identity.composeNetwork, cleanupOrder: 40,
      labels: {
        [COMPOSE_PROJECT_LABEL]: identity.project,
        [COMPOSE_NETWORK_LABEL]: 'edge-docker',
      },
    },
  ];
}

export function forbiddenDockerResources(identity) {
  return [{
    kind: 'network', name: identity.defaultComposeNetwork, cleanupOrder: 39,
    labels: {
      [COMPOSE_PROJECT_LABEL]: identity.project,
      [COMPOSE_NETWORK_LABEL]: 'default',
    },
  }];
}

function createImageAdapters() {
  return {
    async inspect(ref) {
      try {
        const text = command('docker', ['image', 'inspect', '--format', '{{json .}}', ref], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(text);
      } catch (error) {
        if (error?.status === 1) return undefined;
        throw error;
      }
    },
    async tag(sourceId, alias) {
      command('docker', ['tag', sourceId, alias], { stdio: 'pipe' });
    },
    async remove(alias) {
      command('docker', ['image', 'rm', alias], { stdio: 'pipe' });
    },
  };
}

export async function captureBundleImageState(imageAdapters, manifest, acceptedDescriptorIds = new Map()) {
  const states = new Map();
  for (const item of manifest.images) {
    if (states.has(item.image)) throw new Error(`duplicate bundle image ref: ${item.image}`);
    if (!IMMUTABLE_ID.test(String(item.id ?? ''))) throw new Error(`invalid bundle image ID: ${item.image}`);
    const before = await imageAdapters.inspect(item.image);
    const acceptedDescriptorId = acceptedDescriptorIds.get(item.image);
    if (acceptedDescriptorId && !IMMUTABLE_ID.test(acceptedDescriptorId)) {
      throw new Error(`invalid captured image descriptor ID: ${item.image}`);
    }
    states.set(item.image, {
      expectedConfigId: item.id,
      acceptedDescriptorId,
      beforeId: before?.Id,
    });
  }
  return states;
}

export async function assertBundleImagesLoaded(imageAdapters, states) {
  for (const [image, state] of states) {
    const current = await imageAdapters.inspect(image);
    if (!current?.Id) throw new Error(`bundle image was not loaded: ${image}`);
    if (
      current.Id !== state.expectedConfigId
      && current.Id !== state.acceptedDescriptorId
      && current.Id !== state.beforeId
    ) {
      throw new Error(`loaded image does not match captured/config identity: ${image}`);
    }
    state.loadedId = current.Id;
  }
}

export async function restoreBundleImageState(imageAdapters, states) {
  const failures = [];
  for (const [image, state] of [...states.entries()].reverse()) {
    try {
      const current = await imageAdapters.inspect(image);
      if (!current) {
        if (state.beforeId) throw new Error(`pre-existing image ref disappeared: ${image}`);
        continue;
      }
      const allowedCurrent = new Set([
        state.loadedId,
        state.expectedConfigId,
        state.acceptedDescriptorId,
        state.beforeId,
      ].filter(Boolean));
      if (!allowedCurrent.has(current.Id)) throw new Error(`refusing concurrently repointed image ref: ${image}`);
      if (state.beforeId) {
        if (current.Id !== state.beforeId) await imageAdapters.tag(state.beforeId, image);
        const restored = await imageAdapters.inspect(image);
        if (restored?.Id !== state.beforeId) throw new Error(`failed to restore image ref: ${image}`);
      } else {
        await imageAdapters.remove(image);
        if (await imageAdapters.inspect(image)) throw new Error(`loaded image ref still exists: ${image}`);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'offline bundle image-state cleanup failed');
}

async function captureAnyCreatedResources(raw, ledger, expectedResources) {
  const failures = [];
  for (const expected of expectedResources) {
    if (ledger.has(expected.name)) continue;
    try {
      await captureDockerResource(raw, ledger, expected, { optional: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'offline resource discovery failed');
}

function combineErrors(primary, cleanupFailures) {
  if (!cleanupFailures.length) return primary;
  if (!primary) return new AggregateError(cleanupFailures, 'offline verifier cleanup failed');
  return new AggregateError([primary, ...cleanupFailures], 'offline verifier and cleanup failed');
}

export async function runVerification() {
  const identity = createInvocationIdentity();
  const raw = new Docker();
  const imageAdapters = createImageAdapters();
  const dockerLedger = new Map();
  const aliasLedger = new Map();
  const fallbackDescriptorIds = new Map();
  const tempAreas = [];
  const expectedResources = expectedDockerResources(identity);
  const forbiddenResources = forbiddenDockerResources(identity);
  const results = [];
  let bundleImageStates = new Map();
  let installMayHaveLoadedImages = false;

  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  };
  const requireCheck = (name, ok, detail = '') => {
    check(name, ok, detail);
    if (!ok) throw new Error(`prerequisite failed: ${name}`);
  };

  let primaryError;
  try {
    console.log('\n──── 离线安装包 · 断网安装验证 ────\n');
    console.log(`  · run ${identity.runId} / invocation ${identity.invocation}`);

    for (const expected of [...expectedResources, ...forbiddenResources]) {
      await requireDockerNameAbsent(raw, expected);
    }

    const arch = command('docker', ['version', '--format', '{{.Server.Arch}}']).trim();
    const imageAliases = identity.fakeImages;
    const seedArea = createOwnedTempArea(identity, 'seed');
    tempAreas.push(seedArea);
    const bundleArea = createOwnedTempArea(identity, 'bundle');
    tempAreas.push(bundleArea);
    const installArea = createOwnedTempArea(identity, 'install');
    tempAreas.push(installArea);
    const edgeArea = createOwnedTempArea(identity, 'edge-data');
    tempAreas.push(edgeArea);
    const edgeRoot = join(edgeArea.path, 'data');
    mkdirSync(edgeRoot, { mode: 0o777 });

    const source = await selectBundleSource({
      providedBundle: process.env.TLE_PLATFORM_OFFLINE_BUNDLE,
      validateProvided: (bundle) => validateRegularFile(bundle, 'provided exact artifact'),
      buildFallback: async () => {
        const version = JSON.parse(readFileSync(join(REPO, 'apps/manager/package.json'), 'utf8')).version;
        const realManager = process.env.MANAGER_IMAGE ?? `mqttsnet/thinglinks-edge:${version}`;
        for (const [src, dst] of [
          [realManager, imageAliases.manager],
          ['wollomatic/socket-proxy:1.13.1', imageAliases.proxy],
          ['alpine:3.22', imageAliases.init],
        ]) {
          const sourceId = await createTrackedImageAlias(imageAdapters, aliasLedger, src, dst);
          fallbackDescriptorIds.set(dst, sourceId);
        }
        writeFileSync(join(seedArea.path, `${identity.seedPackage}-1.0.0.tgz`), gzipSync(tarArchive([
          {
            name: 'package/package.json',
            content: JSON.stringify({
              name: identity.seedPackage,
              version: '1.0.0',
              description: '离线验证夹具',
              keywords: ['node-red'],
              'node-red': { nodes: { seed: 'seed.js' } },
            }),
          },
          { name: 'package/seed.js', content: 'module.exports = function () {};\n' },
        ])));
        command('./scripts/build-offline-bundle.sh', ['--out', bundleArea.path], {
          env: {
            ...process.env,
            MANAGER_IMAGE: imageAliases.manager,
            PROXY_IMAGE: imageAliases.proxy,
            INIT_IMAGE: imageAliases.init,
            ALLOWED_IMAGE_TAGS: STANDALONE_TAG,
            NODE_SEED_DIR: seedArea.path,
          },
          stdio: 'pipe',
        });
        const bundles = readdirSync(bundleArea.path)
          .filter((name) => /^thinglinks-edge-offline-.*-linux-.*\.tar\.gz$/.test(name));
        if (bundles.length !== 1) throw new Error(`standalone fallback produced ${bundles.length} bundles`);
        return validateRegularFile(join(bundleArea.path, bundles[0]), 'standalone fallback bundle');
      },
    });
    check(source.mode === 'provided'
      ? '复用 verify-all 提供的唯一 exact artifact'
      : '独立运行明确使用 standalone fallback', true, source.bundle.split('/').pop());

    const manifest = readBundleManifest(source.bundle);
    check('exact artifact 通过 RepoTags、Config bytes、env 与 compose 一致性校验', true);

    command('tar', ['-xzf', source.bundle, '-C', installArea.path, '--strip-components', '1']);
    assertOwnedTempArea(installArea);
    for (const file of [
      'images.tar', 'docker-compose.yml', 'docker-compose.offline.yml',
      'install.sh', 'manifest.json', 'SHA256SUMS', '.env.example', 'README.md',
    ]) {
      validateRegularFile(join(installArea.path, file), `bundle ${file}`);
    }
    check('包内含镜像、compose、离线覆盖、安装脚本、清单、校验和、说明', true);

    const envTemplate = parseEnv(readFileSync(join(installArea.path, '.env.example'), 'utf8'));
    const allowedTags = (envTemplate.get('ALLOWED_IMAGE_TAGS') ?? '')
      .split(',').map((tag) => tag.trim()).filter(Boolean);
    const nodeRepo = envTemplate.get('NODE_RED_IMAGE_REPO') ?? '';
    if (allowedTags.length === 0 || !nodeRepo) throw new Error('bundle has no allowed Node-RED image');
    const tag = allowedTags[0];
    const listed = manifest.images.map((item) => item.image);
    requireCheck('清单写明当前 Docker 架构', manifest.platform === `linux/${arch}`, manifest.platform);
    requireCheck('平台三件套与实例镜像都在 exact artifact',
      [
        envTemplate.get('MANAGER_IMAGE'),
        envTemplate.get('PROXY_IMAGE'),
        envTemplate.get('INIT_IMAGE'),
        `${nodeRepo}:${tag}`,
      ].every((image) => listed.includes(image)), listed.join(' '));
    requireCheck('exact artifact 清单列出随包预置节点包',
      Array.isArray(manifest.nodeSeed) && manifest.nodeSeed.length > 0,
      (manifest.nodeSeed ?? []).join(' '));

    const sums = command('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
      cwd: installArea.path,
      stdio: 'pipe',
    });
    requireCheck('校验和自洽（U 盘拷坏能当场发现）', sums.includes('images.tar: OK'));
    requireCheck('所有预置节点包都在校验和里', manifest.nodeSeed.every(
      (name) => sums.includes(`node-seed/${name}: OK`),
    ));

    if (source.mode === 'fallback') {
      await cleanupTrackedImageAliases(imageAdapters, aliasLedger);
      const gone = (await Promise.all(Object.values(imageAliases)
        .map((image) => imageAdapters.inspect(image)))).every((info) => !info);
      requireCheck('安装前独享假仓库 tag 全部不存在，无法回源', gone);
    }

    bundleImageStates = await captureBundleImageState(
      imageAdapters,
      manifest,
      fallbackDescriptorIds,
    );
    const port = await allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(join(installArea.path, '.env'), [
      `EXTERNAL_URL=${baseUrl}`,
      `MASTER_KEY=${randomBytes(32).toString('hex')}`,
      `MANAGER_IMAGE=${envTemplate.get('MANAGER_IMAGE')}`,
      `PROXY_IMAGE=${envTemplate.get('PROXY_IMAGE')}`,
      `INIT_IMAGE=${envTemplate.get('INIT_IMAGE')}`,
      `NODE_RED_IMAGE_REPO=${nodeRepo}`,
      'DOCKER_GID=0',
      'BIND_ADDR=127.0.0.1',
      `HOST_PORT=${port}`,
      `INSTANCE_NETWORK=${identity.instanceNetworkBase}`,
      `ALLOWED_IMAGE_TAGS=${allowedTags.join(',')}`,
      `EDGE_DATA_ROOT=${edgeRoot}`,
      `EDGE_NAME_PREFIX=${identity.prefix}`,
      'INSTANCE_PORT_MIN=31500',
      'INSTANCE_PORT_MAX=31599',
      '',
    ].join('\n'), { mode: 0o600 });

    console.log('  · ./install.sh --yes …');
    installMayHaveLoadedImages = true;
    const installLog = command('./install.sh', ['--yes'], {
      cwd: installArea.path,
      env: { ...process.env, COMPOSE_PROJECT_NAME: identity.project },
      stdio: 'pipe',
    });
    for (const name of [
      identity.managerName,
      identity.proxyName,
      identity.initName,
      identity.composeNetwork,
    ]) {
      await captureDockerResource(raw, dockerLedger,
        expectedResources.find((item) => item.name === name));
    }
    const unexpectedDefault = await captureDockerResource(
      raw,
      dockerLedger,
      forbiddenResources[0],
      { optional: true },
    );
    if (unexpectedDefault) {
      throw new Error(`compose unexpectedly created forbidden default network: ${unexpectedDefault.name}`);
    }
    check('init-data 使用 network_mode:none，未创建 Compose default network', true);
    requireCheck('install.sh 一把跑通（校验 → load → 起服务 → 等健康）',
      installLog.includes('完成'), installLog.trim().split('\n').slice(-1)[0]?.slice(0, 60));
    requireCheck('安装过程没有任何拉取动作', !/Pulling|Pull complete|pulling from/i.test(installLog));
    await assertBundleImagesLoaded(imageAdapters, bundleImageStates);
    check('运行时镜像均由 exact artifact load 后可寻址', true);

    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      await sleep(500);
      ready = await fetch(`${baseUrl}/healthz`).then((response) => response.ok).catch(() => false);
    }
    requireCheck('装完 Manager 就绪并可访问', ready, ready ? baseUrl : '超时');

    const state = await (await fetch(`${baseUrl}/api/setup`)).json();
    requireCheck('全新安装进入首次设置状态', state.needed === true);
    const setupRes = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: SETUP_PW }),
    });
    const cookie = (setupRes.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(';')[0]).join('; ');
    const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    requireCheck('设置管理员后直接拿到会话', setupRes.status === 200 && Boolean(csrf),
      `HTTP ${setupRes.status}`);
    const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

    const store = await (await fetch(`${baseUrl}/api/nodes/store`, { headers })).json();
    const packages = Array.isArray(store.packages) ? store.packages : [];
    const seeded = source.mode === 'fallback'
      ? packages.filter((item) => item.module === identity.seedPackage)
      : packages;
    requireCheck('随包节点包已自动进入私有源', seeded.length > 0,
      packages.map((item) => item.module).join(' ') || '包库是空的');
    requireCheck(source.mode === 'fallback'
      ? '普通随包节点导入后仍未批准'
      : '只自动批准固定 Edge 平台包，common 仍未批准',
      seededApprovalContract(source.mode, seeded),
      seeded.map((item) => `${item.module}:${item.approved}`).join(' '));

    const created = await fetch(`${baseUrl}/api/instances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: identity.instanceId,
        name: '离线验证',
        imageTag: tag,
        memoryMb: 256,
        cpus: 0.5,
        ports: [],
      }),
    });
    const createdText = await created.text();
    if (created.status !== 201) {
      console.log('    ── 排障信息 ──');
      console.log(command('docker', [
        'ps', '-a', '--filter', `name=${identity.prefix}-`,
        '--format', '      {{.Names}} | {{.Image}} | {{.Status}}',
      ]));
      for (const name of [identity.proxyName, identity.managerName]) {
        const log = await raw.getContainer(name).logs({ stdout: true, stderr: true, tail: 8 })
          .then((buffer) => buffer.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, ''))
          .catch((error) => `取不到日志：${error.message}`);
        console.log(`    ${name}:\n${log.split('\n').map((line) => `      ${line}`).join('\n')}`);
      }
    }
    requireCheck('断网条件下能创建实例（验收核心）', created.status === 201,
      `HTTP ${created.status} ${createdText.slice(0, 200)}`);
    const instanceContainer = expectedResources.find((item) => item.name === identity.instanceName);
    const instanceNetwork = expectedResources.find((item) => item.name === identity.instanceNetwork);
    const capturedInstance = await captureDockerResource(raw, dockerLedger, instanceContainer);
    await captureDockerResource(raw, dockerLedger, instanceNetwork);
    const inspectedInstance = await raw.getContainer(capturedInstance.id).inspect();
    requireCheck('实例容器以不可变 ID 确认真实运行', inspectedInstance.State?.Running === true,
      inspectedInstance.State?.Status ?? '不存在');

    const outsideTag = allowedTags.includes('4.1.13-22-minimal')
      ? '9.9.9-not-in-exact-bundle'
      : '4.1.13-22-minimal';
    const outOfBundle = await fetch(`${baseUrl}/api/instances`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: identity.rejectedInstanceId,
        name: '不在包里',
        imageTag: outsideTag,
        memoryMb: 256,
        cpus: 0.5,
        ports: [],
      }),
    });
    const outsideBody = await outOfBundle.json().catch(() => ({}));
    const message = outsideBody.error ?? '';
    requireCheck('选择包外版本时立即拒绝并说明可选项',
      outOfBundle.status === 400 && allowedTags.some((allowed) => message.includes(allowed)),
      String(message).slice(0, 100));

    if (results.some((result) => !result.ok)) throw new Error('offline verification checks failed');
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures = [];
  try {
    await captureAnyCreatedResources(raw, dockerLedger, expectedResources);
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    const unexpectedDefault = await captureDockerResource(
      raw,
      dockerLedger,
      forbiddenResources[0],
      { optional: true },
    );
    if (unexpectedDefault) {
      cleanupFailures.push(new Error(
        `forbidden Compose default network was created: ${unexpectedDefault.name}`,
      ));
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await cleanupTrackedDockerResources(raw, dockerLedger);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (installMayHaveLoadedImages) {
    try {
      await restoreBundleImageState(imageAdapters, bundleImageStates);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await cleanupTrackedImageAliases(imageAdapters, aliasLedger);
  } catch (error) {
    cleanupFailures.push(error);
  }
  for (const area of [...tempAreas].reverse()) {
    try {
      removeOwnedTempArea(area);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  const failure = combineErrors(primaryError, cleanupFailures);
  if (failure) throw failure;
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n  ${passed}/${results.length} 通过\n`);
  return passed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runVerification().catch((error) => {
    console.error('\n验证失败：', error.message);
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error('  -', cause.message);
    }
    process.exitCode = 1;
  });
}
