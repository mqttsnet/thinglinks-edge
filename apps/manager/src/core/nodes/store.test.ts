import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tarArchive } from '../archive/tar.ts';
import { NodeStore, readPackage, compareVersions, closureGaps, closureReport } from './store.ts';
import { NodePolicyError } from './policy.ts';

/** 造一个形状与 `npm pack` 一致的 tgz */
function pack(pkg: Record<string, unknown>, extra: Array<[string, string]> = []): Buffer {
  return gzipSync(tarArchive([
    { name: 'package/package.json', content: JSON.stringify(pkg) },
    { name: 'package/README.md', content: '# x' },
    ...extra.map(([name, content]) => ({ name, content })),
  ]));
}

const nodePkg = (name: string, version: string, deps: Record<string, string> = {}) => ({
  name, version, description: `${name} 说明`, keywords: ['node-red', 'modbus'],
  dependencies: deps,
  'node-red': { nodes: { 'modbus-read': 'modbus.js', 'modbus-write': 'w.js' } },
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tle-nodes-'));
}

test('从真实结构的 tgz 里读出元数据与校验值', () => {
  const tgz = pack(nodePkg('node-red-contrib-modbus', '5.7.0'));
  const meta = readPackage(tgz);
  assert.equal(meta.name, 'node-red-contrib-modbus');
  assert.equal(meta.version, '5.7.0');
  assert.equal(meta.isNodeRedNode, true);
  assert.deepEqual(meta.types, ['modbus-read', 'modbus-write']);
  // 校验值必须来自**文件本身**，否则 npm 下载完会 integrity mismatch
  assert.equal(meta.shasum, createHash('sha1').update(tgz).digest('hex'));
  assert.equal(meta.integrity, `sha512-${createHash('sha512').update(tgz).digest('base64')}`);
  assert.equal(meta.size, tgz.length);
});

test('根目录不叫 package/ 的真实包也要认（@types/* 就是这样）', () => {
  /*
   * 2026-08-31 实测：从 registry 直接下载的 @types/semver@7.7.1，根目录是
   * `semver/` 而不是 `package/`。写死 package/ 前缀会让这类包全部导入失败，
   * 表现是依赖闭包缺一块，而缺口要到现场点安装时才暴露。
   * 一次真包导入里 358 个包有 13 个是这种形状，全是 @types/*。
   */
  const tgz = gzipSync(tarArchive([
    { name: 'semver/LICENSE', content: 'MIT' },
    { name: 'semver/package.json', content: JSON.stringify({ name: '@types/semver', version: '7.7.1' }) },
  ]));
  const meta = readPackage(tgz);
  assert.equal(meta.name, '@types/semver');
  assert.equal(meta.version, '7.7.1');
});

test('有多个第一层 package.json 时优先规范的 package/', () => {
  const tgz = gzipSync(tarArchive([
    { name: 'other/package.json', content: JSON.stringify({ name: 'wrong', version: '9.9.9' }) },
    { name: 'package/package.json', content: JSON.stringify({ name: 'right', version: '1.0.0' }) },
  ]));
  assert.equal(readPackage(tgz).name, 'right');
});

test('只有深层 package.json 不算 —— 那是包内的测试夹具', () => {
  const tgz = gzipSync(tarArchive([
    { name: 'pkg/test/fixtures/package.json', content: JSON.stringify({ name: 'fixture', version: '1.0.0' }) },
  ]));
  assert.throws(() => readPackage(tgz), /第一层目录下没有 package.json/);
});

test('普通 npm 库（节点包的依赖）也收，只是不算节点包', () => {
  // 这条是刻意的：只收节点包会让离线现场装不上依赖，见 store.ts 的说明
  const meta = readPackage(pack({ name: 'jsmodbus', version: '4.0.6' }));
  assert.equal(meta.isNodeRedNode, false);
  assert.deepEqual(meta.types, []);
});

test('依赖与 engines 原样透传 —— packument 靠它解析依赖闭包', () => {
  const meta = readPackage(pack({
    name: 'a', version: '1.0.0',
    dependencies: { b: '^1.0.0' },
    peerDependencies: { 'node-red': '>=3' },
    engines: { node: '>=18' },
  }));
  assert.deepEqual(meta.dependencies, { b: '^1.0.0' });
  assert.deepEqual(meta.peerDependencies, { 'node-red': '>=3' });
  assert.deepEqual(meta.engines, { node: '>=18' });
});

test('坏文件给出能懂的错，而不是抛底层异常', () => {
  assert.throws(() => readPackage(Buffer.from('not gzip')), /不是有效的 gzip/);
  assert.throws(() => readPackage(gzipSync(Buffer.alloc(1024))), /第一层目录下没有 package.json/);
  assert.throws(
    () => readPackage(pack({ name: 'a' } as Record<string, unknown>)),
    /缺 name 或 version/,
  );
  assert.throws(() => readPackage(pack({ name: 'a', version: 'latest' })), /合法 semver/);
});

test('package.json 里的恶意包名在读取时就被挡住', () => {
  // 名字会被拿去拼路径，必须在入库前挡住
  assert.throws(
    () => readPackage(pack({ name: '../../etc/passwd', version: '1.0.0' })),
    NodePolicyError,
  );
});

test('存取一个包：落盘、读回、列版本', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    const tgz = pack(nodePkg('node-red-contrib-modbus', '5.7.0'));
    const meta = store.add(tgz);
    assert.equal(meta.version, '5.7.0');
    assert.ok(store.has('node-red-contrib-modbus', '5.7.0'));
    assert.deepEqual(store.tarball('node-red-contrib-modbus', '5.7.0'), tgz);
    assert.deepEqual(store.modules(), ['node-red-contrib-modbus']);
    assert.deepEqual(store.versions('node-red-contrib-modbus'), ['5.7.0']);
    assert.equal(store.tarball('node-red-contrib-modbus', '9.9.9'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scope 包存成两层目录，且不会被当成一个顶层包', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack(nodePkg('@thinglinks/edge-nodes', '1.0.0')));
    store.add(pack(nodePkg('plain-node', '1.0.0')));
    assert.deepEqual(store.modules(), ['@thinglinks/edge-nodes', 'plain-node']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('版本排序：正式版大于预发布，按数字段而非字典序', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    for (const v of ['1.9.0', '1.10.0', '1.0.0-beta.1']) {
      store.add(pack(nodePkg('n', v)));
    }
    assert.deepEqual(store.versions('n'), ['1.0.0-beta.1', '1.9.0', '1.10.0']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('依赖闭包缺口：报出库里一个版本都没有的包', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack(nodePkg('root-node', '1.0.0', { 'dep-a': '^1.0.0', 'dep-b': '^2.0.0' })));
    assert.deepEqual(closureGaps(store, 'root-node', '1.0.0'), ['dep-a', 'dep-b']);

    // 补进 dep-a，它自己又依赖 dep-c —— 缺口应当递推下去
    store.add(pack({ name: 'dep-a', version: '1.2.0', dependencies: { 'dep-c': '^1.0.0' } }));
    assert.deepEqual(closureGaps(store, 'root-node', '1.0.0'), ['dep-b', 'dep-c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('peerDependencies 不算缺口 —— node-red 本体不该出现在节点源里', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack({
      name: 'n', version: '1.0.0',
      peerDependencies: { 'node-red': '>=3' },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    assert.deepEqual(closureGaps(store, 'n', '1.0.0'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删除一个版本', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack(nodePkg('n', '1.0.0')));
    assert.equal(store.remove('n', '1.0.0'), true);
    assert.equal(store.remove('n', '1.0.0'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('路径穿越尝试被挡在存取入口', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    assert.throws(() => store.tarball('../../etc', '1.0.0'), NodePolicyError);
    assert.throws(() => store.tarball('n', '../../../etc/passwd'), NodePolicyError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 可选依赖（对着 node-red-contrib-modbus 5.60.2 实测后补的回归）────────

test('optionalDependencies 与 peerDependenciesMeta 一并读出来', () => {
  /*
   * modbus 把串口支持放在 optionalDependencies 里。丢了这两个键，
   * 包照样装得上、Modbus TCP 也照常能用，只有 RTU 那半边悄悄失灵 ——
   * 现场排查这种「装成功但少一半功能」要花掉一整天。
   */
  const meta = readPackage(pack({
    name: 'node-red-contrib-modbus', version: '5.60.2',
    dependencies: { jsmodbus: '~4.0.10' },
    optionalDependencies: { serialport: '~13.0.0', '@serialport/list': '~13.0.0' },
    peerDependenciesMeta: { 'supports-color': { optional: true } },
  }));
  assert.deepEqual(meta.optionalDependencies,
    { serialport: '~13.0.0', '@serialport/list': '~13.0.0' });
  assert.deepEqual(meta.peerDependenciesMeta, { 'supports-color': { optional: true } });
});

test('可选依赖的缺口单独报，不和必需依赖混在一起', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack({
      name: 'root-node', version: '1.0.0',
      dependencies: { 'dep-a': '^1.0.0' },
      optionalDependencies: { 'opt-a': '^1.0.0' },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    // 缺可选依赖不该让它看起来像装不上 —— 那是两种严重程度不同的事
    assert.deepEqual(closureReport(store, 'root-node', '1.0.0'),
      { missing: ['dep-a'], missingOptional: ['opt-a'] });
    assert.deepEqual(closureGaps(store, 'root-node', '1.0.0'), ['dep-a']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('库里有的可选依赖要继续往下走 —— 它自己的必需依赖是硬缺口', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack({
      name: 'root-node', version: '1.0.0',
      optionalDependencies: { serialport: '^13.0.0' },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    store.add(pack({
      name: 'serialport', version: '13.0.0',
      dependencies: { '@serialport/stream': '^13.0.0' },
    }));
    assert.deepEqual(closureReport(store, 'root-node', '1.0.0'),
      { missing: ['@serialport/stream'], missingOptional: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一个包既是必需又是可选时按必需算 —— 那是更该先解决的那个', () => {
  const dir = tmp();
  try {
    const store = new NodeStore(dir);
    store.add(pack({
      name: 'root-node', version: '1.0.0',
      dependencies: { both: '^1.0.0' },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    store.add(pack({ name: 'mid', version: '1.0.0', optionalDependencies: { both: '^1.0.0' } }));
    store.add(pack({
      name: 'root2', version: '1.0.0',
      dependencies: { mid: '^1.0.0', both: '^1.0.0' },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    assert.deepEqual(closureReport(store, 'root2', '1.0.0'),
      { missing: ['both'], missingOptional: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
