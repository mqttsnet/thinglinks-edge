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
  bin: string;
  out: string;
  lock: string;
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
    root, bin, out, lock, edge, common, edgeKey, commonKey,
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

test('pack-nodes 不带 expectation 时仍保留通用依赖闭包行为', () => {
  const f = packerFixture();
  try {
    const r = runPacker(f, [f.edgeKey]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(f.out).sort(), [
      'fixture-common-1.0.0.tgz',
      'fixture-edge-1.0.0.tgz',
    ]);
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

test('pack-nodes 替换目录失败时回滚并完整保留上一份种子', () => {
  const f = packerFixture();
  try {
    const old = Buffer.from('previous-valid-seed');
    writeFileSync(join(f.out, 'previous-1.0.0.tgz'), old);
    writeFileSync(join(f.out, 'release.txt'), 'previous');

    const countFile = join(f.root, 'mv-count');
    const fakeMv = join(f.bin, 'mv');
    writeFileSync(fakeMv, [
      '#!/usr/bin/env sh',
      'count=0',
      '[ ! -f "$FAKE_MV_COUNT" ] || count="$(cat "$FAKE_MV_COUNT")"',
      'count=$((count + 1))',
      'printf "%s" "$count" > "$FAKE_MV_COUNT"',
      '[ "$count" -ne 2 ] || exit 73',
      'exec /bin/mv "$@"',
      '',
    ].join('\n'));
    chmodSync(fakeMv, 0o755);
    f.env['FAKE_MV_COUNT'] = countFile;

    const r = runPacker(f, [
      '--expect', `${f.edgeKey}=${f.edgeIntegrity}`,
      '--expect', `${f.commonKey}=${f.commonIntegrity}`,
      f.edgeKey,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /替换种子目录失败.*已恢复上一份/);
    assert.deepEqual(readdirSync(f.out).sort(), ['previous-1.0.0.tgz', 'release.txt']);
    assert.deepEqual(readFileSync(join(f.out, 'previous-1.0.0.tgz')), old);
    assert.equal(readFileSync(join(f.out, 'release.txt'), 'utf8'), 'previous');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('pack-nodes 候选目录复制失败时不触碰上一份种子', () => {
  const f = packerFixture();
  try {
    const old = Buffer.from('previous-valid-seed');
    writeFileSync(join(f.out, 'previous-1.0.0.tgz'), old);

    const fakeCp = join(f.bin, 'cp');
    writeFileSync(fakeCp, [
      '#!/usr/bin/env sh',
      'case "$*" in *.next.*) exit 74 ;; esac',
      'exec /bin/cp "$@"',
      '',
    ].join('\n'));
    chmodSync(fakeCp, 0o755);

    const r = runPacker(f, [f.edgeKey]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /无法完整写入同盘候选目录.*上一份种子保持不变/);
    assert.deepEqual(readdirSync(f.out), ['previous-1.0.0.tgz']);
    assert.deepEqual(readFileSync(join(f.out, 'previous-1.0.0.tgz')), old);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('pack-nodes 拒绝缺 version、resolved 或 integrity 的闭包条目', async (t) => {
  for (const field of ['version', 'resolved', 'integrity'] as const) {
    await t.test(`缺 ${field}`, () => {
      const f = packerFixture();
      try {
        const lock = JSON.parse(readFileSync(f.lock, 'utf8')) as {
          packages: Record<string, Record<string, unknown>>;
        };
        delete lock.packages['node_modules/@fixture/edge']![field];
        writeFileSync(f.lock, JSON.stringify(lock));
        const r = runPacker(f, [f.edgeKey]);
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, new RegExp(`缺 ${field}`));
        assert.deepEqual(readdirSync(f.out), []);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

test('pack-nodes 有 expectation 时拒绝闭包中的额外包', () => {
  const f = packerFixture();
  try {
    const r = runPacker(f, [
      '--expect', `${f.edgeKey}=${f.edgeIntegrity}`,
      f.edgeKey,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未声明的闭包包.*@fixture\/common@1\.0\.0/);
    assert.deepEqual(readdirSync(f.out), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const productionSeed = {
  'mqttsnet-thinglinks-edge-nodes-0.0.1.tgz':
    'sha512-NKsIKyUHNyB+xuXNpCrOqzEYbYflEFeXqC/IgjM2/+AzktSTb7+TZFBWHoqp9FjLDX2crpoah6gn8n+Uy32AkA==',
  'mqttsnet-thinglinks-node-red-common-0.0.1.tgz':
    'sha512-T6QN9RlBF0qbvujaAKNY81BjrcIdbqeqFkLfQsGuKHI8UY2cgad9prF8xUC5n4BbHbNJ7ftBmSBkj+IEZvTJWQ==',
} as const;

test('Docker builder 带 bash、curl 与精确生产种子', {
  skip: process.env['TLE_PLATFORM_BUILDER_IMAGE'] ? false : '仅发布制品门禁运行',
}, () => {
  const image = process.env['TLE_PLATFORM_BUILDER_IMAGE']!;
  const r = spawnSync('docker', [
    'run', '--rm', '--entrypoint', 'sh', image, '-c',
    'command -v bash; command -v curl; find /out/npm-seed -maxdepth 1 -type f -name "*.tgz" -print',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.trim().split('\n').sort();
  assert.deepEqual(lines, [
    '/bin/bash',
    '/out/npm-seed/mqttsnet-thinglinks-edge-nodes-0.0.1.tgz',
    '/out/npm-seed/mqttsnet-thinglinks-node-red-common-0.0.1.tgz',
    '/usr/bin/curl',
  ].sort());
});

test('Docker runtime 只有精确生产种子、保留 raw bundle 且没有 bash/curl', {
  skip: process.env['TLE_PLATFORM_RUNTIME_IMAGE'] ? false : '仅发布制品门禁运行',
}, () => {
  const image = process.env['TLE_PLATFORM_RUNTIME_IMAGE']!;
  const inspect = `
    import { createHash } from 'node:crypto';
    import { existsSync, readFileSync, readdirSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { readPackage } from '/app/dist/core/nodes/store.js';
    const files = readdirSync('/app/npm-seed').filter((f) => f.endsWith('.tgz')).sort();
    const buffers = Object.fromEntries(files.map((file) => [file, readFileSync('/app/npm-seed/' + file)]));
    const integrities = Object.fromEntries(files.map((file) => [file,
      'sha512-' + createHash('sha512').update(buffers[file]).digest('base64')]));
    const metadata = Object.fromEntries(files.map((file) => {
      const meta = readPackage(buffers[file]);
      return [file, { name: meta.name, version: meta.version,
        hasNodeRedMetadata: meta.hasNodeRedMetadata, types: meta.types }];
    }));
    console.log(JSON.stringify({
      files, integrities, metadata,
      rawBundle: existsSync('/app/nodes/tl-device.js'),
      bash: spawnSync('bash').error?.code ?? 'present',
      curl: spawnSync('curl').error?.code ?? 'present',
    }));
  `;
  const r = spawnSync('docker', [
    'run', '--rm', '--entrypoint', 'node', image, '--input-type=module', '-e', inspect,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const observed = JSON.parse(r.stdout) as {
    files: string[];
    integrities: Record<string, string>;
    metadata: Record<string, {
      name: string;
      version: string;
      hasNodeRedMetadata: boolean;
      types: string[];
    }>;
    rawBundle: boolean;
    bash: string;
    curl: string;
  };
  assert.deepEqual(observed.files, Object.keys(productionSeed).sort());
  assert.deepEqual(observed.integrities, productionSeed);
  assert.deepEqual(observed.metadata['mqttsnet-thinglinks-edge-nodes-0.0.1.tgz'], {
    name: '@mqttsnet/thinglinks-edge-nodes',
    version: '0.0.1',
    hasNodeRedMetadata: true,
    types: ['tl-device', 'tl-tag', 'tl-uplink'],
  });
  assert.deepEqual(observed.metadata['mqttsnet-thinglinks-node-red-common-0.0.1.tgz'], {
    name: '@mqttsnet/thinglinks-node-red-common',
    version: '0.0.1',
    hasNodeRedMetadata: false,
    types: [],
  });
  assert.equal(observed.rawBundle, true);
  assert.equal(observed.bash, 'ENOENT');
  assert.equal(observed.curl, 'ENOENT');
});

test('离线包 manifest SRI 与 SHA256SUMS 精确覆盖两个生产 tarball', {
  skip: process.env['TLE_PLATFORM_OFFLINE_BUNDLE'] ? false : '仅发布制品门禁运行',
}, () => {
  const bundle = process.env['TLE_PLATFORM_OFFLINE_BUNDLE']!;
  const listed = spawnSync('tar', ['-tzf', bundle], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const entries = listed.stdout.trim().split('\n');
  const entry = (suffix: string) => {
    const found = entries.find((candidate) => candidate.endsWith(suffix));
    assert.ok(found, `离线包缺 ${suffix}`);
    return found;
  };
  const readEntry = (suffix: string): Buffer => {
    const r = spawnSync('tar', ['-xOzf', bundle, entry(suffix)]);
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout;
  };

  const manifest = JSON.parse(readEntry('/manifest.json').toString()) as {
    nodeSeed: string[];
    nodeSeedIntegrity: Record<string, string>;
  };
  assert.deepEqual(manifest.nodeSeed, Object.keys(productionSeed).sort());
  assert.deepEqual(manifest.nodeSeedIntegrity, productionSeed);

  const sums = readEntry('/SHA256SUMS').toString();
  for (const file of Object.keys(productionSeed)) {
    const tarball = readEntry(`/node-seed/${file}`);
    const sha256 = createHash('sha256').update(tarball).digest('hex');
    assert.match(sums, new RegExp(`^${sha256}  node-seed/${file.replaceAll('.', '\\.')}$`, 'm'));
  }
});
