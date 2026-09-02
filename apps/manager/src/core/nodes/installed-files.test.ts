import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from './platform-contract.ts';
import { verifyInstalledPlatformFiles } from './installed-files.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function validFixture() {
  const instanceDataRoot = mkdtempSync(join(tmpdir(), 'tle-installed-files-'));
  roots.push(instanceDataRoot);
  const instance = join(instanceDataRoot, 'line-a');
  const edgePath = `node_modules/${PLATFORM_NODE_PACKAGE.name}`;
  const commonPath = `node_modules/${PLATFORM_COMMON_PACKAGE.name}`;
  const rootPackage = {
    name: 'node-red-project', private: true,
    dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version },
  };
  const lock = {
    name: 'node-red-project', lockfileVersion: 3,
    packages: {
      '': { dependencies: { [PLATFORM_NODE_PACKAGE.name]: PLATFORM_NODE_PACKAGE.version } },
      [edgePath]: {
        version: PLATFORM_NODE_PACKAGE.version,
        integrity: PLATFORM_NODE_PACKAGE.integrity,
        dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
      },
      [commonPath]: {
        version: PLATFORM_COMMON_PACKAGE.version,
        integrity: PLATFORM_COMMON_PACKAGE.integrity,
      },
    },
  };
  const edge = {
    name: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    dependencies: { [PLATFORM_COMMON_PACKAGE.name]: PLATFORM_COMMON_PACKAGE.version },
    'node-red': {
      version: '>=5.0.4 <6',
      nodes: {
        'tl-device': 'tl-device.js',
        'tl-tag': 'tl-tag.js',
        'tl-uplink': 'tl-uplink.js',
      },
    },
  };
  const common = {
    name: PLATFORM_COMMON_PACKAGE.name,
    version: PLATFORM_COMMON_PACKAGE.version,
    main: 'tl-common.js',
  };
  const paths = {
    root: join(instance, 'package.json'),
    lock: join(instance, 'package-lock.json'),
    edge: join(instance, edgePath, 'package.json'),
    common: join(instance, commonPath, 'package.json'),
  };
  writeJson(paths.root, rootPackage);
  writeJson(paths.lock, lock);
  writeJson(paths.edge, edge);
  writeJson(paths.common, common);
  return { instanceDataRoot, paths, rootPackage, lock, edge, common };
}

const verify = (instanceDataRoot: string) => verifyInstalledPlatformFiles({
  instanceDataRoot, instanceId: 'line-a', readFile,
});

test('valid host package manifests and lock evidence pass without Docker exec', async () => {
  const fixture = validFixture();
  await assert.doesNotReject(() => verify(fixture.instanceDataRoot));
});

test('Node-RED canonical tilde selectors pass with exact installed artifact evidence', async () => {
  const fixture = validFixture();
  fixture.rootPackage.dependencies[PLATFORM_NODE_PACKAGE.name] = '~0.0.1';
  const packages = fixture.lock.packages as Record<string, any>;
  packages[''].dependencies[PLATFORM_NODE_PACKAGE.name] = '~0.0.1';
  writeJson(fixture.paths.root, fixture.rootPackage);
  writeJson(fixture.paths.lock, fixture.lock);

  await assert.doesNotReject(() => verify(fixture.instanceDataRoot));
});

test('root package and lock must both declare an accepted Edge selector', async () => {
  const missing = validFixture();
  writeJson(missing.paths.root, { ...missing.rootPackage, dependencies: {} });
  await assert.rejects(() => verify(missing.instanceDataRoot), /root package.*Edge|Edge.*root package/i);

  const wrong = validFixture();
  const packages = wrong.lock.packages as Record<string, any>;
  packages[''].dependencies[PLATFORM_NODE_PACKAGE.name] = '9.9.9';
  writeJson(wrong.paths.lock, wrong.lock);
  await assert.rejects(() => verify(wrong.instanceDataRoot), /lock.*Edge|Edge.*lock/i);
});

test('root package and lock-project reject non-canonical Edge selectors', async () => {
  const rejectedSelectors = [
    '^0.0.1',
    '>=0.0.1',
    'latest',
    '*',
    'workspace:*',
    'file:../edge-nodes',
    'https://registry.example/thinglinks-edge-nodes-0.0.1.tgz',
    '~0.0.2',
    '0.0.2',
    ' 0.0.1',
    '0.0.1 ',
    '\t~0.0.1',
    '~0.0.1\n',
  ];

  for (const selector of rejectedSelectors) {
    const rootPackage = validFixture();
    rootPackage.rootPackage.dependencies[PLATFORM_NODE_PACKAGE.name] = selector;
    writeJson(rootPackage.paths.root, rootPackage.rootPackage);
    await assert.rejects(
      () => verify(rootPackage.instanceDataRoot),
      /root package.*Edge|Edge.*root package/i,
      `root package accepted ${JSON.stringify(selector)}`,
    );

    const lockProject = validFixture();
    const packages = lockProject.lock.packages as Record<string, any>;
    packages[''].dependencies[PLATFORM_NODE_PACKAGE.name] = selector;
    writeJson(lockProject.paths.lock, lockProject.lock);
    await assert.rejects(
      () => verify(lockProject.instanceDataRoot),
      /lock.*Edge|Edge.*lock/i,
      `root lock project accepted ${JSON.stringify(selector)}`,
    );
  }
});

test('Edge manifest requires exact common dependency and exactly three registrations', async () => {
  const wrongCommon = validFixture();
  wrongCommon.edge.dependencies[PLATFORM_COMMON_PACKAGE.name] = '9.9.9';
  writeJson(wrongCommon.paths.edge, wrongCommon.edge);
  await assert.rejects(() => verify(wrongCommon.instanceDataRoot), /common.*version|version.*common/i);

  const missing = validFixture();
  delete (missing.edge['node-red'].nodes as Record<string, string>)['tl-uplink'];
  writeJson(missing.paths.edge, missing.edge);
  await assert.rejects(() => verify(missing.instanceDataRoot), /registration|node.*type/i);

  const extra = validFixture();
  (extra.edge['node-red'].nodes as Record<string, string>)['tl-extra'] = 'tl-extra.js';
  writeJson(extra.paths.edge, extra.edge);
  await assert.rejects(() => verify(extra.instanceDataRoot), /registration|node.*type/i);
});

test('common manifest must be exact and must not declare node-red metadata', async () => {
  const wrong = validFixture();
  writeJson(wrong.paths.common, { ...wrong.common, version: '9.9.9' });
  await assert.rejects(() => verify(wrong.instanceDataRoot), /common.*version|version.*common/i);

  const metadata = validFixture();
  writeJson(metadata.paths.common, { ...metadata.common, 'node-red': { nodes: {} } });
  await assert.rejects(() => verify(metadata.instanceDataRoot), /common.*node-red|node-red.*common/i);
});

for (const which of ['edge', 'common'] as const) {
  test(`${which} lock integrity mismatch is rejected`, async () => {
    const fixture = validFixture();
    const packages = fixture.lock.packages as Record<string, any>;
    const name = which === 'edge' ? PLATFORM_NODE_PACKAGE.name : PLATFORM_COMMON_PACKAGE.name;
    packages[`node_modules/${name}`].integrity = 'sha512-wrong';
    writeJson(fixture.paths.lock, fixture.lock);
    await assert.rejects(() => verify(fixture.instanceDataRoot), new RegExp(`${which}.*integrity|integrity.*${which}`, 'i'));
  });
}

test('instance ids and symlinked instance roots cannot escape the Manager host data root', async () => {
  const fixture = validFixture();
  await assert.rejects(
    () => verifyInstalledPlatformFiles({
      instanceDataRoot: fixture.instanceDataRoot,
      instanceId: '../outside',
      readFile,
    }),
    /instance|path|ID/i,
  );

  const root = mkdtempSync(join(tmpdir(), 'tle-installed-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'tle-installed-symlink-outside-'));
  roots.push(root, outside);
  symlinkSync(outside, join(root, 'line-a'));
  await assert.rejects(() => verify(root), /escape|contain|symlink|path/i);
});

test('a symlinked manifest cannot redirect reads outside the instance directory', async () => {
  const fixture = validFixture();
  const outside = join(mkdtempSync(join(tmpdir(), 'tle-installed-manifest-outside-')), 'package.json');
  roots.push(dirname(outside));
  writeJson(outside, fixture.common);
  rmSync(fixture.paths.common);
  symlinkSync(outside, fixture.paths.common);
  await assert.rejects(() => verify(fixture.instanceDataRoot), /escape|contain|symlink|path/i);
});
