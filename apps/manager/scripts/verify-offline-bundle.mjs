#!/usr/bin/env node

// 只证明当前入口自产 bundle 的内部一致性与可寻址性；SHA256SUMS 没有签名，
// 因此本脚本不把任意外部 bundle 提升为“来源可信”制品，也绝不执行 docker load。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'images.tar',
  'docker-compose.yml',
  'docker-compose.offline.yml',
  'install.sh',
  'README.md',
  'manifest.json',
  'SHA256SUMS',
  '.env.example',
];

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.status, 0,
    `${command} ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout;
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

function assertTarRegular(archive, member, compressed, label) {
  assert.ok(safeArchiveEntry(member), `${label} has unsafe archive path: ${member}`);
  const mode = compressed ? '-tvzf' : '-tvf';
  const listing = command('tar', [mode, archive, '--', member]).trim().split('\n').filter(Boolean);
  assert.equal(listing.length, 1, `${label} must have exactly one tar header`);
  assert.equal(listing[0][0], '-', `${label} must be a regular tar member`);
}

function readTarMember(archive, member, label) {
  assertTarRegular(archive, member, false, label);
  const result = spawnSync('tar', ['-xOf', archive, '--', member], {
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0,
    `${label} read failed: ${Buffer.from(result.stderr ?? '').toString().trim()}`);
  return Buffer.from(result.stdout);
}

export function indexDockerArchive(archive, expectedImages, expectedArchitecture) {
  assert.ok(Array.isArray(expectedImages) && expectedImages.length > 0,
    'expected image tags missing');
  assert.equal(new Set(expectedImages).size, expectedImages.length,
    'expected image tags contain duplicates');
  assert.match(expectedArchitecture, /^[a-z0-9_]+$/, 'expected architecture invalid');

  const manifest = JSON.parse(readTarMember(
    archive, 'manifest.json', 'images.tar manifest.json').toString());
  assert.ok(Array.isArray(manifest) && manifest.length > 0,
    'images.tar manifest must be a non-empty array');
  const repoTags = manifest.flatMap((item) => Array.isArray(item.RepoTags)
    ? item.RepoTags.filter((tag) => typeof tag === 'string') : []);
  assert.deepEqual([...new Set(repoTags)].sort(), [...expectedImages].sort(),
    'images.tar RepoTags 必须与 outer manifest 精确一致，不得夹带额外 RepoTag');

  const images = {};
  for (const image of expectedImages) {
    const owners = [];
    for (const item of manifest) {
      for (const tag of Array.isArray(item.RepoTags) ? item.RepoTags : []) {
        if (tag === image) owners.push(item);
      }
    }
    assert.equal(owners.length, 1,
      `RepoTag ${image} 必须恰好属于一个 inner manifest item`);
    const config = owners[0].Config;
    assert.ok(typeof config === 'string' && safeArchiveEntry(config),
      `Config path unsafe for ${image}`);
    const bytes = readTarMember(archive, config, `Config ${image}`);
    const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const configJson = JSON.parse(bytes.toString());
    assert.equal(configJson.architecture, expectedArchitecture,
      `Config architecture mismatch: ${image}`);
    images[image] = { id, config, architecture: configJson.architecture };
  }
  for (const item of manifest) {
    assert.ok(Array.isArray(item.RepoTags) && item.RepoTags.length > 0,
      'images.tar contains an untagged extra image item');
    assert.ok(item.RepoTags.every((tag) => expectedImages.includes(tag)),
      'images.tar contains an outer-unmapped image item');
  }
  return { images, repoTags: [...new Set(repoTags)], manifest };
}

export function singleConfigId(archive, expectedArchitecture) {
  assert.match(expectedArchitecture, /^[a-z0-9_]+$/, 'expected architecture invalid');
  const manifest = JSON.parse(readTarMember(
    archive, 'manifest.json', 'descriptor archive manifest.json').toString());
  assert.ok(Array.isArray(manifest), 'descriptor archive manifest must be an array');
  assert.equal(manifest.length, 1, 'descriptor archive must contain exactly one image item');
  const item = manifest[0];
  assert.ok(item.RepoTags == null
    || (Array.isArray(item.RepoTags) && item.RepoTags.every((tag) => typeof tag === 'string')),
  'descriptor archive RepoTags must be null or strings');
  const config = item.Config;
  assert.ok(typeof config === 'string' && safeArchiveEntry(config),
    'descriptor Config path unsafe');
  const bytes = readTarMember(archive, config, 'descriptor Config');
  const configJson = JSON.parse(bytes.toString());
  assert.equal(configJson.architecture, expectedArchitecture,
    'descriptor Config architecture mismatch');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function uniqueSuffix(entries, suffix) {
  const matches = entries.filter((entry) => entry.endsWith(`/${suffix}`));
  assert.equal(matches.length, 1, `bundle must contain exactly one ${suffix}`);
  return matches[0];
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    if (!/^[A-Z0-9_]+=/.test(line)) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    assert.equal(values.has(key), false, `.env.example duplicates ${key}`);
    values.set(key, line.slice(at + 1));
  }
  return values;
}

function cleanComposeEnvironment() {
  const env = { ...process.env, MASTER_KEY: 'bundle-contract-probe' };
  for (const key of [
    'MANAGER_IMAGE',
    'PROXY_IMAGE',
    'INIT_IMAGE',
    'NODE_RED_IMAGE_REPO',
    'ALLOWED_IMAGE_TAGS',
    'COMPOSE_FILE',
    'COMPOSE_PROFILES',
  ]) delete env[key];
  return env;
}

function assertOwnedScratch(root, parent, prefix, marker, runId) {
  assert.equal(realpathSync(root), root, 'scratch path changed');
  assert.ok(root.startsWith(`${parent}${sep}${prefix}`), 'scratch escaped temp parent');
  const stat = lstatSync(marker);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'scratch owner marker changed');
  assert.equal(readFileSync(marker, 'utf8'), `${runId}\n`, 'scratch owner changed');
}

function assertRegularContained(path, root, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  const canonical = realpathSync(path);
  const rel = relative(root, canonical);
  assert.ok(rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)),
    `${label} escaped package root`);
}

function checksumPaths(text) {
  const paths = text.trim().split('\n').filter(Boolean).map((line) => {
    const match = /^[0-9a-f]{64}  (.+)$/.exec(line);
    assert.ok(match, `invalid SHA256SUMS line: ${line}`);
    const path = match[1];
    assert.ok(safeArchiveEntry(path) && !path.startsWith('/'), `unsafe SHA256SUMS path: ${path}`);
    return path;
  });
  assert.equal(new Set(paths).size, paths.length, 'SHA256SUMS 路径不得重复');
  return paths;
}

export function verifyOfflineBundle(bundleArg, expectedManagerTag, expectedManagerConfigId) {
  assert.ok(bundleArg && expectedManagerTag && expectedManagerConfigId,
    'usage: verify-offline-bundle.mjs <bundle> <manager-tag> <manager-config-id>');
  assert.doesNotMatch(expectedManagerTag, /^sha256:|@sha256:/,
    'manager bundle reference must be a named tag');
  assert.match(expectedManagerConfigId, /^sha256:[0-9a-f]{64}$/,
    'manager config must be an immutable sha256 ID');

  const bundle = resolve(bundleArg);
  const runId = process.env.TLE_VERIFY_RUN_ID ?? 'standalone';
  assert.match(runId, /^[a-z0-9][a-z0-9_.-]{0,80}$/);
  const parent = realpathSync(tmpdir());
  const prefix = `tle-offline-contract.${runId}.`;
  const scratch = realpathSync(mkdtempSync(join(parent, prefix)));
  const marker = join(scratch, '.owner');
  writeFileSync(marker, `${runId}\n`, { mode: 0o600 });
  const checks = [];
  const check = (name, action) => {
    try {
      action();
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
    checks.push(name);
    console.log(`  ✓ ${name}`);
  };

  try {
    const entries = command('tar', ['-tzf', bundle]).trim().split('\n').filter(Boolean);
    check('外层归档路径均受限', () => assert.ok(entries.every(safeArchiveEntry)));
    const selected = Object.fromEntries(REQUIRED.map((name) => [name, uniqueSuffix(entries, name)]));
    const packageRootEntry = dirname(selected['manifest.json']);
    check('外层归档只含单一包根且路径唯一', () => {
      assert.equal(new Set(entries).size, entries.length, 'bundle archive contains duplicate paths');
      assert.ok(entries.every((entry) => (
        entry === packageRootEntry
        || entry === `${packageRootEntry}/`
        || entry.startsWith(`${packageRootEntry}/`)
      )), 'bundle archive contains entries outside package root');
    });
    check('关键文件位于同一包根', () => {
      for (const name of REQUIRED) {
        assert.equal(dirname(selected[name]), packageRootEntry, name);
      }
    });
    check('关键 tar 成员均为普通文件', () => {
      for (const name of REQUIRED) {
        assertTarRegular(bundle, selected[name], true, name);
      }
    });

    command('tar', ['-xzf', bundle, '-C', scratch, '--', ...Object.values(selected)]);
    const packageRoot = join(scratch, packageRootEntry);
    check('包根与关键文件均为边界内普通文件', () => {
      const rootStat = lstatSync(packageRoot);
      assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'package root changed');
      assert.equal(realpathSync(packageRoot), packageRoot, 'package root escaped scratch');
      for (const name of REQUIRED) {
        assertRegularContained(join(scratch, selected[name]), packageRoot, name);
      }
    });

    const sumsText = readFileSync(join(packageRoot, 'SHA256SUMS'), 'utf8');
    const summedPaths = checksumPaths(sumsText);
    const summedEntries = summedPaths.map((path) => `${packageRootEntry}/${path}`);
    const deliveryEntries = entries.filter((entry) => (
      entry.startsWith(`${packageRootEntry}/`)
      && !entry.endsWith('/')
      && entry !== selected['SHA256SUMS']
    ));
    check('SHA256SUMS 精确覆盖所有交付文件', () => {
      assert.deepEqual([...summedEntries].sort(), [...deliveryEntries].sort());
    });
    check('SHA256SUMS 引用均在同一包根且唯一', () => {
      for (const entry of summedEntries) {
        assert.equal(entries.filter((candidate) => candidate === entry).length, 1, entry);
      }
    });
    const extraEntries = summedEntries.filter((entry) => !Object.values(selected).includes(entry));
    check('SHA256SUMS tar 成员均为普通文件', () => {
      for (const entry of extraEntries) {
        assertTarRegular(bundle, entry, true, entry);
      }
    });
    if (extraEntries.length > 0) {
      command('tar', ['-xzf', bundle, '-C', scratch, '--', ...extraEntries]);
    }
    check('SHA256SUMS 文件均为边界内普通文件', () => {
      for (const path of summedPaths) {
        assertRegularContained(join(packageRoot, path), packageRoot, path);
      }
    });
    check('SHA256SUMS 覆盖内容自洽', () => {
      command('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: packageRoot });
    });

    const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.images) && manifest.images.length >= 4,
      'bundle manifest images missing');
    const manager = manifest.images[0];
    check('manifest Manager tag 与 descriptor 归档 Config ID 同源', () => {
      assert.deepEqual(manager, { image: expectedManagerTag, id: expectedManagerConfigId });
    });

    const imagesTar = join(packageRoot, 'images.tar');
    const imageRefs = manifest.images.map((item) => item.image);
    check('离线包不含裸 image ID/digest 引用', () => {
      assert.deepEqual(imageRefs.filter((image) => /^sha256:|@sha256:/.test(image)), []);
    });
    const expectedArchitecture = String(manifest.platform ?? '').split('/')[1] ?? '';
    let archiveIndex;
    check('inner RepoTags 精确唯一绑定 Config bytes 与 outer image ID', () => {
      archiveIndex = indexDockerArchive(imagesTar, imageRefs, expectedArchitecture);
      for (const item of manifest.images) {
        assert.match(item.id, /^sha256:[0-9a-f]{64}$/, `${item.image} outer image ID`);
        assert.equal(archiveIndex.images[item.image].id, item.id,
          `Config bytes 与 outer image ID 不一致：${item.image}`);
      }
    });
    const repoTags = new Set(archiveIndex.repoTags);

    const envFile = join(packageRoot, '.env.example');
    const env = parseEnv(readFileSync(envFile, 'utf8'));
    const allowedTags = (env.get('ALLOWED_IMAGE_TAGS') ?? '').split(',')
      .map((tag) => tag.trim()).filter(Boolean);
    const nodeRepo = env.get('NODE_RED_IMAGE_REPO') ?? '';
    check('.env.example 与 manifest 镜像一致', () => {
      assert.equal(env.get('MANAGER_IMAGE'), manifest.images[0].image);
      assert.equal(env.get('PROXY_IMAGE'), manifest.images[1].image);
      assert.equal(env.get('INIT_IMAGE'), manifest.images[2].image);
      assert.deepEqual(allowedTags.map((tag) => `${nodeRepo}:${tag}`), imageRefs.slice(3));
    });

    const composeText = command('docker', [
      'compose', '--env-file', envFile,
      '-f', join(packageRoot, 'docker-compose.yml'),
      '-f', join(packageRoot, 'docker-compose.offline.yml'),
      'config', '--format', 'json',
    ], { cwd: packageRoot, env: cleanComposeEnvironment() });
    const compose = JSON.parse(composeText);
    const services = compose.services ?? {};
    check('compose 解析引用 images.tar 同一组 tag', () => {
      assert.equal(services.manager?.image, manifest.images[0].image);
      assert.equal(services['docker-proxy']?.image, manifest.images[1].image);
      assert.equal(services['init-data']?.image, manifest.images[2].image);
      for (const service of ['manager', 'docker-proxy', 'init-data']) {
        assert.ok(repoTags.has(services[service]?.image), service);
        assert.equal(services[service]?.pull_policy, 'never', `${service} pull_policy`);
      }
      assert.equal(services.manager?.environment?.NODE_RED_IMAGE_REPO, nodeRepo);
      assert.equal(services.manager?.environment?.ALLOWED_IMAGE_TAGS, allowedTags.join(','));
    });

    console.log(`\n  ${checks.length}/${checks.length} 通过\n`);
    return checks.length;
  } finally {
    assertOwnedScratch(scratch, parent, prefix, marker, runId);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv[2] === '--index') {
      const [archive, architecture, ...images] = process.argv.slice(3);
      const index = indexDockerArchive(archive, images, architecture);
      process.stdout.write(`${JSON.stringify(index.images, null, 2)}\n`);
    } else if (process.argv[2] === '--single-config-id') {
      const id = singleConfigId(process.argv[3], process.argv[4]);
      process.stdout.write(`${id}\n`);
    } else {
      verifyOfflineBundle(process.argv[2], process.argv[3], process.argv[4]);
    }
  } catch (error) {
    console.error(`verify-offline-bundle failed: ${error.message}`);
    process.exitCode = 1;
  }
}
