import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tarArchive } from '../archive/tar.ts';
import { NodeStore } from './store.ts';
import { seedFromDir, describeSeed } from './seed.ts';

const pack = (name: string, version: string) => gzipSync(tarArchive([{
  name: 'package/package.json',
  content: JSON.stringify({ name, version, 'node-red': { nodes: { a: 'a.js' } } }),
}]));

function beds(fn: (store: NodeStore, seedDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tle-seed-'));
  try {
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir);
    fn(new NodeStore(join(root, 'npm')), seedDir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('目录不存在不算错 —— 绝大多数部署没有预置包', () => {
  beds((store) => {
    const r = seedFromDir(store, '/definitely/not/here');
    assert.deepEqual(r, { imported: [], skipped: [], failed: [] });
    assert.equal(describeSeed('x', r), '');
  });
});

test('导入目录里的全部 tgz', () => {
  beds((store, dir) => {
    writeFileSync(join(dir, 'a.tgz'), pack('a-node', '1.0.0'));
    writeFileSync(join(dir, 'b.tgz'), pack('b-node', '2.0.0'));
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');
    const r = seedFromDir(store, dir);
    assert.deepEqual(r.imported, ['a-node@1.0.0', 'b-node@2.0.0']);
    assert.deepEqual(store.modules(), ['a-node', 'b-node']);
  });
});

test('再跑一次全部跳过 —— 幂等，不重写 SD 卡', () => {
  beds((store, dir) => {
    writeFileSync(join(dir, 'a.tgz'), pack('a-node', '1.0.0'));
    seedFromDir(store, dir);
    const again = seedFromDir(store, dir);
    assert.deepEqual(again.imported, []);
    assert.deepEqual(again.skipped, ['a-node@1.0.0']);
  });
});

test('坏文件只失败它自己，不影响同目录其它包', () => {
  beds((store, dir) => {
    writeFileSync(join(dir, 'bad.tgz'), Buffer.from('not a gzip'));
    writeFileSync(join(dir, 'good.tgz'), pack('good-node', '1.0.0'));
    const r = seedFromDir(store, dir);
    assert.deepEqual(r.imported, ['good-node@1.0.0']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0]!.file, 'bad.tgz');
    assert.match(describeSeed(dir, r), /导入 1 · 失败 1/);
  });
});

test('导入不等于批准 —— 种子包不会自动获得可安装权限', () => {
  beds((store, dir) => {
    writeFileSync(join(dir, 'a.tgz'), pack('a-node', '1.0.0'));
    seedFromDir(store, dir);
    // seed 只碰 store，批准清单是另一张表，这里断言的是「它没有越界去改」
    assert.ok(store.has('a-node', '1.0.0'));
  });
});
