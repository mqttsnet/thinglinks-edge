import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { tarArchive } from '../../core/archive/tar.ts';
import { openDb } from '../../core/db.ts';
import { NodeCatalog } from '../../core/nodes/catalog.ts';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from '../../core/nodes/platform-contract.ts';
import {
  verifyPlatformPackageStore,
  type PlatformPackageTrustContract,
  type PlatformRegistryVerifier,
} from '../../core/nodes/platform-package.ts';
import { NodeStore } from '../../core/nodes/store.ts';
import type { HttpContext } from '../context.ts';
import { parseNpmPath, registerNpmRegistry, versionFromTarball } from './registry.ts';

function pack(pkg: Record<string, unknown>, marker = ''): Buffer {
  return gzipSync(tarArchive([
    { name: 'package/package.json', content: JSON.stringify(pkg) },
    { name: 'package/marker.txt', content: marker },
  ]));
}

function platformFixture() {
  const common = pack({
    name: PLATFORM_COMMON_PACKAGE.name,
    version: PLATFORM_COMMON_PACKAGE.version,
  });
  const edge = pack({
    name: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
    'node-red': { nodes: {
      'tl-device': 'tl-device.js', 'tl-tag': 'tl-tag.js', 'tl-uplink': 'tl-uplink.js',
    } },
  });
  const sri = (body: Buffer) =>
    `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const contract: PlatformPackageTrustContract = {
    node: { ...PLATFORM_NODE_PACKAGE, integrity: sri(edge) },
    common: { ...PLATFORM_COMMON_PACKAGE, integrity: sri(common) },
    nodeTypes: PLATFORM_NODE_TYPES,
  };
  return { edge, common, contract };
}

function fixtureVerifier(
  store: NodeStore,
  contract: PlatformPackageTrustContract,
  afterVerify?: () => void,
): PlatformRegistryVerifier {
  return {
    snapshotForRegistry(name, version) {
      const verified = verifyPlatformPackageStore(store, contract);
      const selected = name === contract.node.name && version === contract.node.version
        ? verified.node
        : name === contract.common.name && version === contract.common.version
          ? verified.common
          : undefined;
      afterVerify?.();
      return selected;
    },
  };
}

async function registryResponse(opts: {
  store: NodeStore;
  path: string;
  verifier?: PlatformRegistryVerifier;
}) {
  const app = Fastify({ logger: false });
  const db = openDb(':memory:');
  registerNpmRegistry(app, {
    config: { basePath: '' },
    db,
  } as HttpContext, {
    store: opts.store,
    catalog: new NodeCatalog(db),
    internalBase: 'http://manager:19100/npm/',
    platformPackages: opts.verifier,
  });
  try { return await app.inject({ method: 'GET', url: opts.path }); }
  finally { await app.close(); }
}

test('普通包名', () => {
  assert.deepEqual(parseNpmPath('node-red-contrib-modbus'),
    { module: 'node-red-contrib-modbus' });
});

test('scope 包的两种写法都要认 —— npm 有时发编码过的斜杠', () => {
  assert.deepEqual(parseNpmPath('@thinglinks/edge-nodes'),
    { module: '@thinglinks/edge-nodes' });
  assert.deepEqual(parseNpmPath('@thinglinks%2fedge-nodes'),
    { module: '@thinglinks/edge-nodes' });
});

test('包体路径切出模块名与文件名', () => {
  assert.deepEqual(parseNpmPath('a-node/-/a-node-1.0.0.tgz'),
    { module: 'a-node', tarball: 'a-node-1.0.0.tgz' });
  assert.deepEqual(parseNpmPath('@s/a/-/a-1.0.0.tgz'),
    { module: '@s/a', tarball: 'a-1.0.0.tgz' });
});

test('文件名里带路径分隔符一律拒绝', () => {
  assert.equal(parseNpmPath('a/-/../../etc/passwd'), undefined);
  assert.equal(parseNpmPath('a/-/'), undefined);
});

test('空路径没有意义', () => {
  assert.equal(parseNpmPath(''), undefined);
  assert.equal(parseNpmPath('/'), undefined);
});

test('从文件名取版本，含预发布标记', () => {
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0.tgz'), '1.0.0');
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0-beta.1.tgz'), '1.0.0-beta.1');
  // scope 包的文件名只有最后一段
  assert.equal(versionFromTarball('@s/a', 'a-2.3.4.tgz'), '2.3.4');
});

test('对不上包名的文件名不认', () => {
  assert.equal(versionFromTarball('a-node', 'other-1.0.0.tgz'), undefined);
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0.zip'), undefined);
  assert.equal(versionFromTarball('a-node', 'a-node-.tgz'), undefined);
});

test('固定平台包没有注入校验能力时失败关闭', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-registry-'));
  try {
    const store = new NodeStore(root);
    const f = platformFixture();
    store.add(f.edge);
    store.add(f.common);
    const response = await registryResponse({
      store,
      path: '/npm/@mqttsnet/thinglinks-edge-nodes',
    });
    assert.equal(response.statusCode, 503);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('固定平台 packument 来自本次校验过的快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-registry-'));
  try {
    const store = new NodeStore(root);
    const f = platformFixture();
    store.add(f.edge);
    store.add(f.common);
    const response = await registryResponse({
      store,
      path: '/npm/@mqttsnet/thinglinks-edge-nodes',
      verifier: fixtureVerifier(store, f.contract),
    });
    assert.equal(response.statusCode, 200);
    const doc = response.json();
    assert.equal(doc['dist-tags'].latest, PLATFORM_NODE_PACKAGE.version);
    assert.equal(doc.versions['0.0.1'].dist.integrity, f.contract.node.integrity);
    assert.deepEqual(doc.versions['0.0.1'].dependencies,
      { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('固定平台 tarball 响应发送校验时读取的同一个 Buffer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-registry-'));
  try {
    const store = new NodeStore(root);
    const f = platformFixture();
    store.add(f.edge);
    store.add(f.common);
    const changed = pack({
      name: PLATFORM_NODE_PACKAGE.name,
      version: PLATFORM_NODE_PACKAGE.version,
    }, 'changed-after-verify');
    const response = await registryResponse({
      store,
      path: '/npm/@mqttsnet/thinglinks-edge-nodes/-/thinglinks-edge-nodes-0.0.1.tgz',
      verifier: fixtureVerifier(store, f.contract, () => {
        writeFileSync(join(root, PLATFORM_NODE_PACKAGE.name,
          `${PLATFORM_NODE_PACKAGE.version}.tgz`), changed);
      }),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, f.edge);
    assert.notDeepEqual(response.rawPayload, changed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('安装预检后固定包被替换时 npm fetch 失败且不发送篡改字节', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-registry-'));
  try {
    const store = new NodeStore(root);
    const f = platformFixture();
    store.add(f.edge);
    store.add(f.common);
    verifyPlatformPackageStore(store, f.contract); // install preflight
    const changed = pack({
      name: PLATFORM_NODE_PACKAGE.name,
      version: PLATFORM_NODE_PACKAGE.version,
    }, 'tampered-before-fetch');
    writeFileSync(join(root, PLATFORM_NODE_PACKAGE.name,
      `${PLATFORM_NODE_PACKAGE.version}.tgz`), changed);

    const response = await registryResponse({
      store,
      path: '/npm/@mqttsnet/thinglinks-edge-nodes/-/thinglinks-edge-nodes-0.0.1.tgz',
      verifier: fixtureVerifier(store, f.contract),
    });
    assert.equal(response.statusCode, 503);
    assert.notDeepEqual(response.rawPayload, changed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('非平台包 packument 与 tarball 保持原行为', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-registry-'));
  try {
    const store = new NodeStore(root);
    const body = pack({ name: 'ordinary-node', version: '1.2.3' });
    store.add(body);
    const packument = await registryResponse({ store, path: '/npm/ordinary-node' });
    assert.equal(packument.statusCode, 200);
    assert.equal(packument.json()['dist-tags'].latest, '1.2.3');
    const tarball = await registryResponse({
      store, path: '/npm/ordinary-node/-/ordinary-node-1.2.3.tgz',
    });
    assert.equal(tarball.statusCode, 200);
    assert.deepEqual(tarball.rawPayload, body);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
