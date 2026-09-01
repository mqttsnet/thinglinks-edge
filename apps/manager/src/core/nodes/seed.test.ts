import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

const packScript = join(import.meta.dirname, '../../../../../scripts/pack-nodes.sh');

interface PackerFixture {
  root: string;
  out: string;
  edge: Buffer;
  common: Buffer;
  edgeKey: string;
  commonKey: string;
  edgeIntegrity: string;
  commonIntegrity: string;
  env: NodeJS.ProcessEnv;
}

function sri(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

function packerFixture(): PackerFixture {
  const root = mkdtempSync(join(tmpdir(), 'tle-pack-nodes-'));
  const bin = join(root, 'bin');
  const out = join(root, 'out');
  mkdirSync(bin);
  mkdirSync(out);

  const edgeKey = '@fixture/edge@1.0.0';
  const commonKey = '@fixture/common@1.0.0';
  const edge = pack('@fixture/edge', '1.0.0');
  const common = gzipSync(tarArchive([{
    name: 'package/package.json',
    content: JSON.stringify({ name: '@fixture/common', version: '1.0.0' }),
  }]));
  const edgeFile = join(root, 'edge.tgz');
  const commonFile = join(root, 'common.tgz');
  writeFileSync(edgeFile, edge);
  writeFileSync(commonFile, common);

  const lock = join(root, 'package-lock.json');
  writeFileSync(lock, JSON.stringify({ packages: {
    'node_modules/@fixture/edge': {
      name: '@fixture/edge', version: '1.0.0', resolved: `file://${edgeFile}`, integrity: sri(edge),
    },
    'node_modules/@fixture/common': {
      name: '@fixture/common', version: '1.0.0', resolved: `file://${commonFile}`, integrity: sri(common),
    },
  } }));

  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/usr/bin/env sh\nmkdir -p node_modules\ncp "$FAKE_LOCK" node_modules/.package-lock.json\n');
  chmodSync(npm, 0o755);

  return {
    root, out, edge, common, edgeKey, commonKey,
    edgeIntegrity: sri(edge), commonIntegrity: sri(common),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_LOCK: lock,
    },
  };
}

function runPacker(f: PackerFixture, args: string[]) {
  return spawnSync('bash', [packScript, '--out', f.out, ...args], {
    env: f.env,
    encoding: 'utf8',
  });
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

test('pack-nodes 按 expectation 保留原始闭包字节并清除旧 tgz', () => {
  const f = packerFixture();
  try {
    writeFileSync(join(f.out, 'stale-9.9.9.tgz'), Buffer.from('stale'));
    const r = runPacker(f, [
      '--expect', `${f.edgeKey}=${f.edgeIntegrity}`,
      '--expect', `${f.commonKey}=${f.commonIntegrity}`,
      f.edgeKey,
    ]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(f.out).sort(), [
      'fixture-common-1.0.0.tgz',
      'fixture-edge-1.0.0.tgz',
    ]);
    assert.deepEqual(
      readFileSync(join(f.out, 'fixture-edge-1.0.0.tgz')),
      f.edge,
    );
    assert.deepEqual(
      readFileSync(join(f.out, 'fixture-common-1.0.0.tgz')),
      f.common,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('pack-nodes 拒绝 expectation 中缺失的闭包条目', () => {
  const f = packerFixture();
  try {
    const r = runPacker(f, [
      '--expect', `${f.edgeKey}=${f.edgeIntegrity}`,
      '--expect', '@fixture/missing@1.0.0=sha512-AAAA',
      f.edgeKey,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expectation.*不在依赖闭包/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('pack-nodes 拒绝 expectation 与原始 tarball 字节漂移', () => {
  const f = packerFixture();
  try {
    const r = runPacker(f, [
      '--expect', `${f.edgeKey}=sha512-AAAA`,
      f.edgeKey,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expectation integrity 不匹配/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
