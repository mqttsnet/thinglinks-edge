import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tarArchive } from '../archive/tar.ts';
import { openDb } from '../db.ts';
import { NodeCatalog } from './catalog.ts';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from './platform-contract.ts';
import {
  ensurePlatformApproval,
  PlatformPackageService,
  verifyPlatformPackageStore,
  type PlatformPackageTrustContract,
} from './platform-package.ts';
import { NodeStore } from './store.ts';

function pack(pkg: Record<string, unknown>, marker = ''): Buffer {
  return gzipSync(tarArchive([
    { name: 'package/package.json', content: JSON.stringify(pkg) },
    { name: 'package/marker.txt', content: marker },
  ]));
}

function integrity(body: Buffer): string {
  return `sha512-${createHash('sha512').update(body).digest('base64')}`;
}

function fixture(overrides: {
  edgeDependencies?: Record<string, string>;
  edgeTypes?: Record<string, string>;
  commonNodeRed?: Record<string, unknown>;
} = {}) {
  const common = pack({
    name: PLATFORM_COMMON_PACKAGE.name,
    version: PLATFORM_COMMON_PACKAGE.version,
    ...(overrides.commonNodeRed ? { 'node-red': overrides.commonNodeRed } : {}),
  });
  const edge = pack({
    name: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    dependencies: overrides.edgeDependencies ?? {
      [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version,
    },
    'node-red': { nodes: overrides.edgeTypes ?? {
      'tl-device': 'tl-device.js',
      'tl-tag': 'tl-tag.js',
      'tl-uplink': 'tl-uplink.js',
    } },
  });
  const contract: PlatformPackageTrustContract = {
    node: { ...PLATFORM_NODE_PACKAGE, integrity: integrity(edge) },
    common: { ...PLATFORM_COMMON_PACKAGE, integrity: integrity(common) },
    nodeTypes: PLATFORM_NODE_TYPES,
  };
  return { edge, common, contract };
}

function withStore(run: (store: NodeStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tle-platform-'));
  try { run(new NodeStore(root), root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('platform contract pins names, versions, integrities, and node types', () => {
  assert.equal(PLATFORM_NODE_PACKAGE.name,
    '@mqttsnet/thinglinks-edge-nodes');
  assert.equal(PLATFORM_NODE_PACKAGE.version, '0.0.1');
  assert.equal(PLATFORM_COMMON_PACKAGE.name,
    '@mqttsnet/thinglinks-node-red-common');
  assert.equal(PLATFORM_COMMON_PACKAGE.version, '0.0.1');
  assert.deepEqual(PLATFORM_NODE_TYPES,
    ['tl-device', 'tl-tag', 'tl-uplink']);
});

test('platform bootstrap approves only exact Edge package', () => {
  const catalog = new NodeCatalog(openDb(':memory:'));
  ensurePlatformApproval(catalog, 'system');
  assert.deepEqual(catalog.approved(), [{
    module: '@mqttsnet/thinglinks-edge-nodes',
    version: '0.0.1',
  }]);
  assert.equal(catalog.get('@mqttsnet/thinglinks-node-red-common'),
    undefined);
});

test('platform store rejects an Edge integrity mismatch', () => {
  withStore((store) => {
    const f = fixture();
    store.add(f.edge);
    store.add(f.common);
    assert.throws(() => verifyPlatformPackageStore(store, {
      ...f.contract,
      node: { ...f.contract.node, integrity: 'sha512-wrong' },
    }), /integrity|完整性/i);
  });
});

test('platform store requires the pinned common package', () => {
  withStore((store) => {
    const f = fixture();
    store.add(f.edge);
    assert.throws(() => verifyPlatformPackageStore(store, f.contract),
      /common|公共包|缺少/i);
  });
});

test('platform common package must not declare node-red metadata', () => {
  withStore((store) => {
    const f = fixture({ commonNodeRed: {} });
    store.add(f.edge);
    store.add(f.common);
    assert.throws(() => verifyPlatformPackageStore(store, f.contract), /node-red/i);
  });
});

test('platform Edge package must expose exactly the three pinned types', () => {
  withStore((store) => {
    const f = fixture({ edgeTypes: {
      'tl-device': 'tl-device.js',
      'tl-tag': 'tl-tag.js',
      extra: 'extra.js',
    } });
    store.add(f.edge);
    store.add(f.common);
    assert.throws(() => verifyPlatformPackageStore(store, f.contract), /节点类型|types/i);
  });
});

test('platform Edge package requires exact common version instead of a range', () => {
  withStore((store) => {
    const f = fixture({ edgeDependencies: {
      [PLATFORM_COMMON_PACKAGE.name]: '^0.0.1',
    } });
    store.add(f.edge);
    store.add(f.common);
    assert.throws(() => verifyPlatformPackageStore(store, f.contract), /0\.0\.1|依赖/i);
  });
});

test('replacing fixed bytes behind the store API is detected before install', () => {
  withStore((store, root) => {
    const f = fixture();
    store.add(f.edge);
    store.add(f.common);
    verifyPlatformPackageStore(store, f.contract);

    const changed = pack({
      name: PLATFORM_NODE_PACKAGE.name,
      version: PLATFORM_NODE_PACKAGE.version,
      dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
      'node-red': { nodes: {
        'tl-device': 'tl-device.js', 'tl-tag': 'tl-tag.js', 'tl-uplink': 'tl-uplink.js',
      } },
    }, 'tampered');
    writeFileSync(join(root, PLATFORM_NODE_PACKAGE.name,
      `${PLATFORM_NODE_PACKAGE.version}.tgz`), changed);

    assert.throws(() => verifyPlatformPackageStore(store, f.contract),
      /integrity|完整性/i);
  });
});

function insertLegacyCommonApproval(db: ReturnType<typeof openDb>): void {
  db.prepare(
    `INSERT INTO node_catalog (module, version, note, approved_by, approved_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(PLATFORM_COMMON_PACKAGE.name, PLATFORM_COMMON_PACKAGE.version,
    'legacy', 'legacy');
}

test('PlatformPackageService bootstrap fails before approving Edge when legacy common is approved', () => {
  withStore((store) => {
    const db = openDb(':memory:');
    const catalog = new NodeCatalog(db);
    insertLegacyCommonApproval(db);
    const service = new PlatformPackageService({ store, catalog });

    assert.throws(() => service.bootstrap('system'), /common.*批准|批准.*common/i);
    assert.equal(catalog.get(PLATFORM_NODE_PACKAGE.name), undefined);
  });
});

test('PlatformPackageService verifyForInstall fails closed on legacy common approval', () => {
  withStore((store) => {
    const db = openDb(':memory:');
    const catalog = new NodeCatalog(db);
    ensurePlatformApproval(catalog, 'system');
    insertLegacyCommonApproval(db);
    const service = new PlatformPackageService({ store, catalog });

    assert.throws(() => service.verifyForInstall(), /common.*批准|批准.*common/i);
  });
});

test('PlatformPackageService bootstrap invokes the hard-wired store verifier', () => {
  withStore((store) => {
    const f = fixture();
    store.add(f.edge);
    store.add(f.common);
    const catalog = new NodeCatalog(openDb(':memory:'));
    const service = new PlatformPackageService({ store, catalog });

    assert.throws(() => service.bootstrap('system'), /integrity|完整性/i);
    assert.equal(catalog.get(PLATFORM_NODE_PACKAGE.name), undefined);
  });
});

test('PlatformPackageService verifyForInstall succeeds then rejects bytes replaced after baseline', () => {
  withStore((store, root) => {
    const f = fixture();
    store.add(f.edge);
    store.add(f.common);
    const catalog = new NodeCatalog(openDb(':memory:'));
    ensurePlatformApproval(catalog, 'system');
    const service = new class extends PlatformPackageService {
      protected verifyCurrentStore() {
        return verifyPlatformPackageStore(store, f.contract);
      }
    }({ store, catalog });

    const baseline = service.verifyForInstall();
    assert.deepEqual(baseline.buffer, f.edge);

    writeFileSync(join(root, PLATFORM_NODE_PACKAGE.name,
      `${PLATFORM_NODE_PACKAGE.version}.tgz`), pack({
      name: PLATFORM_NODE_PACKAGE.name,
      version: PLATFORM_NODE_PACKAGE.version,
    }, 'replaced-before-install'));
    assert.throws(() => service.verifyForInstall(), /integrity|完整性/i);
  });
});
