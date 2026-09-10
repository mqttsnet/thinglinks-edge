import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(SCRIPT_DIR, 'verify-offline-bundle.mjs');
const MANAGER = 'thinglinks-edge-manager-verify:artifact-test';
const PROXY = 'fixture/proxy:1';
const INIT = 'fixture/init:1';
const NODE_REPO = 'fixture/node-red';
const NODE_TAG = '5.0.4-test';
const NODE_IMAGE = `${NODE_REPO}:${NODE_TAG}`;

function configBytes(image, index, extra = {}) {
  return Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', image, index, ...extra }));
}

function bufferId(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

const MANAGER_ID = bufferId(configBytes(MANAGER, 0));

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture({
  nullRepoTags = false,
  composeManager = MANAGER,
  symlinkEnv = false,
  hardlinkEnv = false,
  packageName = 'thinglinks-edge-offline-test-linux-amd64',
  forgedManagerConfig = false,
  duplicateManagerTag = false,
  missingManagerConfig = false,
  unsafeManagerConfig = false,
  extraInnerTag = false,
  omitChecksumFor = '',
  duplicateChecksum = '',
  extraFiles = 0,
  extraType = 'regular',
  duplicateExtra = false,
  corruptExtra = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tle-offline-contract-test-'));
  const bin = join(root, 'bin');
  const stage = join(root, packageName);
  mkdirSync(bin);
  mkdirSync(stage);

  const images = [MANAGER, PROXY, INIT, NODE_IMAGE];
  const inner = join(root, 'inner');
  mkdirSync(inner);
  const innerManifest = [];
  const innerFiles = [];
  const outerImages = images.map((image, index) => {
    const bytes = configBytes(image, index,
      index === 0 && forgedManagerConfig ? { forged: true } : {});
    const actualId = bufferId(bytes);
    let config = `${actualId.slice('sha256:'.length)}.json`;
    if (index === 0 && missingManagerConfig) config = 'missing.json';
    if (index === 0 && unsafeManagerConfig) config = '../outside.json';
    if (!missingManagerConfig && !unsafeManagerConfig) {
      writeFileSync(join(inner, config), bytes);
      innerFiles.push(config);
    }
    innerManifest.push({
      Config: config,
      RepoTags: index === 0 && nullRepoTags
        ? null
        : [image, ...(index === 0 && extraInnerTag ? ['victim/repo:tag'] : [])],
      Layers: [],
    });
    return { image, id: index === 0 ? MANAGER_ID : actualId };
  });
  if (duplicateManagerTag) {
    const bytes = configBytes(MANAGER, 99);
    const config = `${bufferId(bytes).slice('sha256:'.length)}.json`;
    writeFileSync(join(inner, config), bytes);
    innerFiles.push(config);
    innerManifest.push({ Config: config, RepoTags: [MANAGER], Layers: [] });
  }
  writeFileSync(join(inner, 'manifest.json'), JSON.stringify(innerManifest));
  assert.equal(spawnSync('/usr/bin/tar', [
    '-cf', join(stage, 'images.tar'), '-C', inner, '--', 'manifest.json', ...innerFiles,
  ]).status, 0);

  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({
    platform: 'linux/amd64',
    images: outerImages,
  }));
  const envText = [
    `MANAGER_IMAGE=${MANAGER}`,
    `PROXY_IMAGE=${PROXY}`,
    `INIT_IMAGE=${INIT}`,
    `NODE_RED_IMAGE_REPO=${NODE_REPO}`,
    `ALLOWED_IMAGE_TAGS=${NODE_TAG}`,
    'EXTERNAL_URL=http://127.0.0.1:19100',
    'MASTER_KEY=',
    '',
  ].join('\n');
  if (symlinkEnv) {
    writeFileSync(join(root, 'outside-env'), envText);
    symlinkSync('../outside-env', join(stage, '.env.example'));
  } else if (hardlinkEnv) {
    writeFileSync(join(stage, '0-env-source'), envText);
    linkSync(join(stage, '0-env-source'), join(stage, '.env.example'));
  } else {
    writeFileSync(join(stage, '.env.example'), envText);
  }
  writeFileSync(join(stage, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(stage, 'docker-compose.offline.yml'), 'services: {}\n');
  writeFileSync(join(stage, 'install.sh'), '#!/bin/sh\nset -e\n');
  writeFileSync(join(stage, 'README.md'), '# Offline fixture\n');

  const extraNames = Array.from({ length: extraFiles }, (_, index) => `nodes/protocol ${index}.tgz`);
  if (extraNames.length) {
    mkdirSync(join(stage, 'nodes'));
    for (const name of extraNames) writeFileSync(join(stage, name), `protocol archive fixture ${name}\n`);
    if (extraType === 'symlink') {
      rmSync(join(stage, extraNames[0]));
      writeFileSync(join(root, 'outside-package'), 'outside fixture\n');
      symlinkSync('../../outside-package', join(stage, extraNames[0]));
    } else if (extraType === 'hardlink') {
      assert.ok(extraNames.length >= 2);
      rmSync(join(stage, extraNames[1]));
      linkSync(join(stage, extraNames[0]), join(stage, extraNames[1]));
    } else if (extraType === 'fifo') {
      rmSync(join(stage, extraNames[0]));
      assert.equal(spawnSync('mkfifo', [join(stage, extraNames[0])]).status, 0);
    }
  }

  const checksummed = [
    'images.tar', 'docker-compose.yml', 'docker-compose.offline.yml',
    'install.sh', 'README.md', 'manifest.json', '.env.example',
    ...(hardlinkEnv ? ['0-env-source'] : []),
    ...extraNames,
  ].filter((name) => name !== omitChecksumFor);
  const checksumLines = checksummed
    .map((name) => `${extraType !== 'regular' && name === extraNames[0]
      ? '0'.repeat(64) : sha(join(stage, name))}  ${name}`);
  if (duplicateChecksum) {
    checksumLines.push(`${sha(join(stage, duplicateChecksum))}  ${duplicateChecksum}`);
  }
  writeFileSync(join(stage, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
  if (corruptExtra) writeFileSync(join(stage, extraNames[0]), 'changed after checksum\n');

  const bundle = join(root, 'bundle.tar.gz');
  // GNU tar and BSD tar traverse directories differently. The first inode member
  // stores the bytes; put its source first so .env.example is always the hardlink.
  // List every file exactly once instead of adding the directory recursively.
  const outerMembers = hardlinkEnv
    ? ['0-env-source', ...readdirSync(stage).filter((name) => name !== '0-env-source').sort()]
      .map((name) => `${packageName}/${name}`)
    : [packageName];
  if (duplicateExtra) outerMembers.push(`${packageName}/${extraNames[0]}`);
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', bundle, '-C', root, '--', ...outerMembers]).status, 0);

  const tarLog = join(root, 'tar-calls.jsonl');
  writeFileSync(join(bin, 'tar'), `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(tarLog)}, JSON.stringify(args) + '\\n');
const result = spawnSync('/usr/bin/tar', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  chmodSync(join(bin, 'tar'), 0o755);

  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!/bin/sh
set -e
[ "$1" = compose ] || exit 91
printf '%s\\n' '{"services":{"manager":{"image":"${composeManager}","pull_policy":"never","environment":{"NODE_RED_IMAGE_REPO":"${NODE_REPO}","ALLOWED_IMAGE_TAGS":"${NODE_TAG}"}},"docker-proxy":{"image":"${PROXY}","pull_policy":"never"},"init-data":{"image":"${INIT}","pull_policy":"never"}}}'
`);
  chmodSync(docker, 0o755);

  return {
    root,
    bundle,
    tarCalls() { return readFileSync(tarLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    run() {
      return spawnSync(process.execPath, [VERIFY, bundle, MANAGER, MANAGER_ID], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TLE_VERIFY_RUN_ID: 'artifact-test',
        },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('exact bundle 的 RepoTags、manifest、env 与 compose config 构成同一引用链', () => {
  const bed = fixture();
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /(\d+)\/\1 通过/);
    assert.doesNotMatch(result.stdout, /0\/0 通过/);
  } finally {
    bed.cleanup();
  }
});

test('many extra delivery files use one outer verbose tar scan, including paths with spaces', () => {
  const bed = fixture({ extraFiles: 24, packageName: 'offline package with spaces' });
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const verboseScans = bed.tarCalls().filter(args => args[0] === '-tvzf' && args[1] === bed.bundle);
    assert.equal(verboseScans.length, 1, 'outer member types must be read once, not by rescanning for each package');
  } finally { bed.cleanup(); }
});

for (const extraType of ['symlink', 'hardlink', 'fifo']) {
  test(`extra checksum member ${extraType} is rejected before extraction`, () => {
    const bed = fixture({ extraFiles: 2, extraType });
    try {
      const result = bed.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /普通文件|regular tar member|member type/);
      assert.equal(bed.tarCalls().some(args => args[0] === '-xzf'
        && args.some(arg => arg.endsWith('/nodes/protocol 0.tgz') || arg.endsWith('/nodes/protocol 1.tgz'))), false);
    } finally { bed.cleanup(); }
  });
}

test('duplicate extra archive paths and changed extra bytes still fail the bundle contract', () => {
  for (const option of [{ duplicateExtra: true }, { corruptExtra: true }]) {
    const bed = fixture({ extraFiles: 2, ...option });
    try {
      const result = bed.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, option.duplicateExtra ? /duplicate paths|路径唯一/ : /SHA256SUMS|checksum|FAILED/);
    } finally { bed.cleanup(); }
  }
});

test('README 或其他交付文件未被 SHA256SUMS 覆盖时拒绝', () => {
  const bed = fixture({ omitChecksumFor: 'README.md' });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /SHA256SUMS.*精确覆盖|未覆盖|README/);
  } finally {
    bed.cleanup();
  }
});

test('SHA256SUMS 重复声明同一路径时拒绝', () => {
  const bed = fixture({ duplicateChecksum: 'install.sh' });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /SHA256SUMS.*重复|duplicate/i);
  } finally {
    bed.cleanup();
  }
});

test('images.tar RepoTags null 时 exact bundle contract 失败', () => {
  const bed = fixture({ nullRepoTags: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /RepoTags.*manifest/);
  } finally {
    bed.cleanup();
  }
});

test('compose 解析出的 Manager tag 与 bundle 不同则失败', () => {
  const bed = fixture({ composeManager: 'foreign/manager:old' });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /compose 解析引用/);
  } finally {
    bed.cleanup();
  }
});

test('关键文件是指向包根外的 symlink 时在读取前拒绝', () => {
  const bed = fixture({ symlinkEnv: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /普通文件|regular non-symlink/);
  } finally {
    bed.cleanup();
  }
});

test('关键文件是 tar hardlink 时在读取前拒绝', () => {
  const bed = fixture({ hardlinkEnv: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /普通文件|regular tar member/);
  } finally {
    bed.cleanup();
  }
});

test('首路径段以 - 开头的真实 tar 根名在任何提取前拒绝', () => {
  const bed = fixture({ packageName: '-malicious-root' });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /外层归档路径均受限/);
  } finally {
    bed.cleanup();
  }
});

test('RepoTag 指向伪造 Config bytes 但 outer 声称可信 ID 时拒绝', () => {
  const bed = fixture({ forgedManagerConfig: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Config bytes.*image ID|Config.*哈希/);
  } finally {
    bed.cleanup();
  }
});

test('同一 RepoTag 出现在多个 inner manifest item 时拒绝', () => {
  const bed = fixture({ duplicateManagerTag: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /RepoTag.*唯一|恰好一个/);
  } finally {
    bed.cleanup();
  }
});

test('inner manifest 夹带 outer 未声明的额外 RepoTag 时拒绝', () => {
  const bed = fixture({ extraInnerTag: true });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /RepoTags.*精确|额外 RepoTag|outer/);
  } finally {
    bed.cleanup();
  }
});

for (const [name, option] of [
  ['缺失', { missingManagerConfig: true }],
  ['越界', { unsafeManagerConfig: true }],
]) {
  test(`inner Config ${name}时拒绝`, () => {
    const bed = fixture(option);
    try {
      const result = bed.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Config/);
    } finally {
      bed.cleanup();
    }
  });
}

for (const [label, repoTags] of [
  ['RepoTags null', null],
  ['未来 Docker 恢复 named RepoTags', ['future/runtime:tag']],
]) {
  test(`--single-config-id 从 ${label} 的单镜像 descriptor 归档导出 Config ID`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tle-single-config-test-'));
    try {
      const config = configBytes('descriptor-only', 1);
      const configId = bufferId(config);
      const configName = `${configId.slice('sha256:'.length)}.json`;
      writeFileSync(join(root, configName), config);
      writeFileSync(join(root, 'manifest.json'), JSON.stringify([{
        Config: configName, RepoTags: repoTags, Layers: [],
      }]));
      const archive = join(root, 'descriptor.tar');
      assert.equal(spawnSync('/usr/bin/tar', [
        '-cf', archive, '-C', root, '--', 'manifest.json', configName,
      ]).status, 0);
      const descriptorId = `sha256:${'d'.repeat(64)}`;
      const result = spawnSync(process.execPath, [
        VERIFY, '--single-config-id', archive, 'amd64',
      ], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stdout.trim(), configId);
      assert.notEqual(result.stdout.trim(), descriptorId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
