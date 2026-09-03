import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '../../..');
const BUILD = join(REPO, 'scripts/build-offline-bundle.sh');
const MANAGER = 'thinglinks-edge-manager-offline-verify:bundle-test';
const PROXY = 'fixture/socket-proxy:1';
const INIT = 'fixture/init:1';
const NODE_REPO = 'fixture/node-red';
const TAGS = '5.0.4-fixture';

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`);
  chmodSync(path, 0o755);
}

function envRecord(text) {
  return Object.fromEntries(text.split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
}

function bed({ nullRepoTags = false, manager = MANAGER } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tle-offline-build-test-'));
  const bin = join(root, 'bin');
  const out = join(root, 'out');
  const capture = join(root, 'capture');
  mkdirSync(bin);
  mkdirSync(out);
  mkdirSync(capture);

  const archiveHelper = join(root, 'archive-helper.mjs');
  writeFileSync(archiveHelper, `
	import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
	import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [out, nullTags, ...images] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'tle-docker-save-fixture-'));
try {
	  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux' }));
	  const configName = createHash('sha256').update(config).digest('hex') + '.json';
	  writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{
	    Config: configName, RepoTags: nullTags === '1' ? null : images, Layers: [],
	  }]));
	  writeFileSync(join(dir, configName), config);
	  const result = spawnSync('/usr/bin/tar', ['-cf', out, '-C', dir, '--', 'manifest.json', configName]);
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`);

  executable(join(bin, 'docker'), String.raw`
case "$1:$2" in
  version:--format) printf '%s\n' amd64 ;;
  image:inspect)
    case "$*" in
      *Architecture*) printf '%s\n' amd64 ;;
      *'json .Id'*) printf '%s\n' '"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' ;;
    esac
    ;;
  save:-o)
    output="$3"
    shift 3
    "$REAL_NODE" "$FAKE_ARCHIVE_HELPER" "$output" "$FAKE_NULL_REPO_TAGS" "$@"
    ;;
  *) echo "unexpected docker command: $*" >&2; exit 91 ;;
esac
`);

  executable(join(bin, 'tar'), String.raw`
if [ "$1" = -xOf ] || [ "$1" = -tvf ]; then
  exec /usr/bin/tar "$@"
fi
[ "$1" = -C ] && [ "$3" = -czf ] || exit 92
cp -R "$2/$5/." "$FAKE_CAPTURE/"
: > "$4"
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    FAKE_ARCHIVE_HELPER: archiveHelper,
    FAKE_NULL_REPO_TAGS: nullRepoTags ? '1' : '0',
    FAKE_CAPTURE: capture,
    MANAGER_IMAGE: manager,
    PROXY_IMAGE: PROXY,
    INIT_IMAGE: INIT,
    NODE_RED_IMAGE_REPO: NODE_REPO,
    ALLOWED_IMAGE_TAGS: TAGS,
    NODE_SEED_DIR: '',
  };
  return {
    root,
    capture,
    run() {
      return spawnSync('bash', [BUILD, '--out', out], { cwd: REPO, env, encoding: 'utf8' });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('bundle 写入实际镜像配置且 images.tar RepoTags 可供 compose 寻址', () => {
  const fixture = bed();
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = envRecord(readFileSync(join(fixture.capture, '.env.example'), 'utf8'));
    assert.deepEqual({
      MANAGER_IMAGE: env.MANAGER_IMAGE,
      PROXY_IMAGE: env.PROXY_IMAGE,
      INIT_IMAGE: env.INIT_IMAGE,
      NODE_RED_IMAGE_REPO: env.NODE_RED_IMAGE_REPO,
      ALLOWED_IMAGE_TAGS: env.ALLOWED_IMAGE_TAGS,
    }, {
      MANAGER_IMAGE: MANAGER,
      PROXY_IMAGE: PROXY,
      INIT_IMAGE: INIT,
      NODE_RED_IMAGE_REPO: NODE_REPO,
      ALLOWED_IMAGE_TAGS: TAGS,
    });
    const manifest = JSON.parse(spawnSync('/usr/bin/tar', [
      '-xOf', join(fixture.capture, 'images.tar'), 'manifest.json',
    ], { encoding: 'utf8' }).stdout);
    const repoTags = manifest.flatMap((item) => item.RepoTags ?? []);
    assert.ok(repoTags.includes(MANAGER));
    const config = spawnSync('/usr/bin/tar', [
      '-xOf', join(fixture.capture, 'images.tar'), '--', manifest[0].Config,
    ]).stdout;
    const archiveId = `sha256:${createHash('sha256').update(config).digest('hex')}`;
    const packageManifest = JSON.parse(readFileSync(join(fixture.capture, 'manifest.json'), 'utf8'));
    assert.ok(packageManifest.images.every((item) => item.id === archiveId));
    assert.notEqual(archiveId, `sha256:${'a'.repeat(64)}`,
      'fixture docker inspect ID must not be trusted after save');
    assert.match(readFileSync(join(fixture.capture, 'docker-compose.yml'), 'utf8'),
      /NODE_RED_IMAGE_REPO: \$\{NODE_RED_IMAGE_REPO:-nodered\/node-red\}/);
    assert.match(result.stdout, /images\.tar RepoTags\/Config.*全部绑定/);
  } finally {
    fixture.cleanup();
  }
});

test('docker save 产生 RepoTags null 时拒绝生成不可安装 bundle', () => {
  const fixture = bed({ nullRepoTags: true });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /images\.tar RepoTags.*manifest/);
  } finally {
    fixture.cleanup();
  }
});

test('裸 sha256 MANAGER_IMAGE 在 docker save 前即被拒绝', () => {
  const fixture = bed({ manager: `sha256:${'a'.repeat(64)}` });
  try {
    const result = fixture.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /named tag.*裸 ID\/digest/);
  } finally {
    fixture.cleanup();
  }
});
