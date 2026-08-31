import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tarArchive } from '../archive/tar.ts';
import { NodeStore } from './store.ts';
import { buildPackument, buildCatalogue, tarballUrl, isNonRegistrySpec } from './packument.ts';

function pack(pkg: Record<string, unknown>): Buffer {
  return gzipSync(tarArchive([{ name: 'package/package.json', content: JSON.stringify(pkg) }]));
}
const node = (name: string, version: string, deps = {}) => ({
  name, version, description: `${name} 的说明`, keywords: ['modbus'], dependencies: deps,
  'node-red': { nodes: { [`${name}-in`]: 'a.js' } },
});

function withStore(fn: (s: NodeStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tle-pkm-'));
  try { fn(new NodeStore(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('包体地址用 npm 惯用形状', () => {
  assert.equal(tarballUrl('http://m:1/x/npm/', 'a-node', '1.0.0'),
    'http://m:1/x/npm/a-node/-/a-node-1.0.0.tgz');
  // scope 包的文件名只取最后一段，与 npm 一致
  assert.equal(tarballUrl('http://m:1/x/npm', '@s/a', '1.0.0'),
    'http://m:1/x/npm/@s/a/-/a-1.0.0.tgz');
});

test('packument 含 npm 装包必需的字段', () => {
  withStore((store) => {
    store.add(pack(node('a-node', '1.0.0', { dep: '^1.0.0' })));
    store.add(pack(node('a-node', '1.2.0', { dep: '^1.0.0' })));
    const doc = buildPackument(store, 'a-node', 'http://m:1/npm/')!;

    assert.equal(doc.name, 'a-node');
    // dist-tags.latest 是 npm info 读的那个字段（Node-RED 装包前的版本预检靠它）
    assert.equal(doc['dist-tags'].latest, '1.2.0');
    assert.deepEqual(Object.keys(doc.versions).sort(), ['1.0.0', '1.2.0']);

    const v = doc.versions['1.2.0']!;
    assert.equal(v.dist.tarball, 'http://m:1/npm/a-node/-/a-node-1.2.0.tgz');
    assert.match(v.dist.integrity, /^sha512-/);
    assert.equal(v.dist.shasum.length, 40);
    // 依赖必须在场，否则 npm 不会去装传递依赖
    assert.deepEqual(v.dependencies, { dep: '^1.0.0' });
  });
});

test('库里没有的包回 undefined，由路由翻成 404', () => {
  withStore((store) => {
    assert.equal(buildPackument(store, 'nope', 'http://m/'), undefined);
  });
});

test('catalogue 只列节点包，不列它们的依赖', () => {
  withStore((store) => {
    store.add(pack(node('a-node', '1.0.0')));
    store.add(pack({ name: 'jsmodbus', version: '4.0.6' }));   // 普通库
    const cat = buildCatalogue(store, { name: 'x' });
    assert.deepEqual(cat.modules.map((m) => m.id), ['a-node']);
    assert.deepEqual(cat.modules[0]!.types, ['a-node-in']);
  });
});

test('catalogue 只列已批准的 —— 未批准的列出来也是灰的', () => {
  withStore((store) => {
    store.add(pack(node('a-node', '1.0.0')));
    store.add(pack(node('b-node', '1.0.0')));
    const cat = buildCatalogue(store, { name: 'x', approved: new Set(['a-node']) });
    assert.deepEqual(cat.modules.map((m) => m.id), ['a-node']);
  });
});

test('catalogue 取每个包的最新版本', () => {
  withStore((store) => {
    store.add(pack(node('a-node', '1.0.0')));
    store.add(pack(node('a-node', '2.0.0')));
    const cat = buildCatalogue(store, { name: 'x' });
    assert.equal(cat.modules[0]!.version, '2.0.0');
  });
});

// ── 非注册表依赖的改写（对着 node-red-contrib-modbus 5.60.2 实测后补）──────
//
// 实测：modbus 把 @openp4nr/modbus-serial 声明成一个 cloudsmith 的 tarball URL。
// 不改写的话，npm 拿到 packument 后**绕开私有源直接去连那个域名**，
// 离线现场报 `ECONNRESET ... Client network socket disconnected` ——
// 而报错里根本看不出「源里其实有这个包」。

test('认得出指向注册表之外的依赖声明', () => {
  for (const spec of [
    'https://dl.cloudsmith.io/public/x/npm/y/8.4.0/y-8.4.0.tgz',
    'http://example.com/a.tgz',
    'git+https://github.com/a/b.git',
    'git+ssh://git@github.com/a/b.git',
    'git@github.com:a/b.git',
    'github:expressjs/express',
    'file:../local-pkg',
    'expressjs/express',
    'expressjs/express#semver:^4.0.0',
  ]) {
    assert.equal(isNonRegistrySpec(spec), true, `${spec} 应判为非注册表`);
  }
  for (const spec of ['^1.0.0', '~4.0.10', '1.2.3', '>=3', '*', 'latest', '1.x',
    // npm: 别名仍然走 registry，不能动它
    'npm:other-pkg@^1.0.0', 'npm:@scope/pkg@^1.0.0']) {
    assert.equal(isNonRegistrySpec(spec), false, `${spec} 应判为普通版本范围`);
  }
});

test('URL 依赖被改写成库里真实存在的版本 —— 否则 npm 会绕开私有源出网', () => {
  withStore((store) => {
    const url = 'https://dl.cloudsmith.io/public/x/npm/modbus-serial/8.4.0/y-8.4.0.tgz';
    store.add(pack({ name: '@openp4nr/modbus-serial', version: '8.4.0' }));
    store.add(pack(node('node-red-contrib-modbus', '5.60.2',
      { '@openp4nr/modbus-serial': url, jsmodbus: '~4.0.10' })));

    const v = buildPackument(store, 'node-red-contrib-modbus', 'http://m:1/npm/')!
      .versions['5.60.2']!;
    // 钉成确切版本：库里有什么就是什么
    assert.equal(v.dependencies['@openp4nr/modbus-serial'], '8.4.0');
    // 普通版本范围一律不动
    assert.equal(v.dependencies['jsmodbus'], '~4.0.10');
  });
});

test('库里没有那个包时 URL 原样留着 —— 改写只会把缺包伪装成解析失败', () => {
  withStore((store) => {
    const url = 'https://example.com/nowhere-1.0.0.tgz';
    store.add(pack(node('a-node', '1.0.0', { nowhere: url })));
    const v = buildPackument(store, 'a-node', 'http://m:1/npm/')!.versions['1.0.0']!;
    assert.equal(v.dependencies['nowhere'], url);
  });
});

test('optionalDependencies 与 peerDependenciesMeta 进 packument', () => {
  withStore((store) => {
    // 漏了 optionalDependencies，包照样装上、串口（RTU）却静悄悄地没了
    store.add(pack({
      name: 'm-node', version: '1.0.0',
      optionalDependencies: { serialport: '~13.0.0' },
      peerDependenciesMeta: { 'supports-color': { optional: true } },
      'node-red': { nodes: { a: 'a.js' } },
    }));
    const v = buildPackument(store, 'm-node', 'http://m:1/npm/')!.versions['1.0.0']!;
    assert.deepEqual(v.optionalDependencies, { serialport: '~13.0.0' });
    assert.deepEqual(v.peerDependenciesMeta, { 'supports-color': { optional: true } });
  });
});

test('URL 里写明版本时按它取，而不是一律取库里最新的', () => {
  withStore((store) => {
    // 库里同时存着两版是常态：不同节点包各要一版
    store.add(pack({ name: 'dep-lib', version: '8.4.0' }));
    store.add(pack({ name: 'dep-lib', version: '9.1.0' }));
    store.add(pack(node('a-node', '1.0.0',
      { 'dep-lib': 'https://dl.example.com/pub/x/dep-lib-8.4.0.tgz' })));

    const v = buildPackument(store, 'a-node', 'http://m:1/npm/')!.versions['1.0.0']!;
    assert.equal(v.dependencies['dep-lib'], '8.4.0');
  });
});

test('URL 里那一版库里没有时退回最新的 —— 总比原样留个连不上的地址强', () => {
  withStore((store) => {
    store.add(pack({ name: 'dep-lib', version: '9.1.0' }));
    store.add(pack(node('a-node', '1.0.0',
      { 'dep-lib': 'https://dl.example.com/pub/x/dep-lib-8.4.0.tgz' })));

    const v = buildPackument(store, 'a-node', 'http://m:1/npm/')!.versions['1.0.0']!;
    assert.equal(v.dependencies['dep-lib'], '9.1.0');
  });
});
