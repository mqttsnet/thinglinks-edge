import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
const VERIFY_ALL = join(SCRIPT_DIR, 'verify-all.sh');
const REPO = resolve(SCRIPT_DIR, '../../..');
const IMMUTABLE_RUNTIME = `sha256:${'a'.repeat(64)}`;
const IMMUTABLE_BUILDER = `sha256:${'b'.repeat(64)}`;
const IMMUTABLE_CONFIG = `sha256:${'e'.repeat(64)}`;
const IMMUTABLE_FOREIGN = `sha256:${'d'.repeat(64)}`;
const GIT_HEAD = 'f'.repeat(40);

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`);
  chmodSync(path, 0o755);
}

function lines(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fakeBed(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tle-verify-all-test-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const log = join(root, 'log');
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(log);

  for (const kind of ['containers', 'volumes', 'networks']) {
    writeFileSync(join(state, `${kind}.before`), options[`${kind}Before`] ?? '');
    writeFileSync(join(state, `${kind}.after`), options[`${kind}After`] ?? '');
  }

  executable(join(bin, 'docker'), String.raw`
printf '%s\n' "$*" >> "$FAKE_LOG/docker"
last=''
for arg in "$@"; do last="$arg"; done
case "$1:$2" in
  ps:-aq|ps:-a) kind=containers ;;
  volume:ls) kind=volumes ;;
  network:ls) kind=networks ;;
  image:inspect)
    [ "$FAKE_INSPECT_FAIL" != 1 ] || exit 44
    if [ "$FAKE_RUNTIME_ID_INSPECT_FAIL_ONCE" = 1 ] \
        && [ -f "$FAKE_STATE/runtime-built" ] \
        && [ ! -f "$FAKE_STATE/runtime-id-inspect-failed" ]; then
      case "$last:$*" in
        thinglinks-edge-manager-verify:*:*'{{.Id}}'*)
          : > "$FAKE_STATE/runtime-id-inspect-failed"
          exit 44
          ;;
      esac
    fi
    case "$last" in
      thinglinks-edge-manager-verify:*)
        [ ! -f "$FAKE_STATE/runtime-removed" ] || exit 44
        [ "$FAKE_RUNTIME_TAG_EXISTS" = 1 ] || [ -f "$FAKE_STATE/runtime-built" ] || exit 44
        ;;
      thinglinks-edge-manager-builder-verify:*)
        [ ! -f "$FAKE_STATE/builder-removed" ] || exit 44
        [ "$FAKE_BUILDER_TAG_EXISTS" = 1 ] || [ -f "$FAKE_STATE/builder-built" ] || exit 44
        ;;
      thinglinks-edge-manager-offline-verify:*)
        [ -f "$FAKE_STATE/export-tagged" ] && [ ! -f "$FAKE_STATE/offline-removed" ] || exit 44
        ;;
    esac
    case "$last" in
      *builder*) image_id="$FAKE_BUILDER_ID"; tag_kind=builder ;;
      *offline*) image_id="$FAKE_RUNTIME_ID"; tag_kind=offline ;;
      *) image_id="$FAKE_RUNTIME_ID"; tag_kind=runtime ;;
    esac
    owner="$TLE_VERIFY_RUN_ID"
    if [ -f "$FAKE_STATE/cleanup-phase" ] && [ "$FAKE_REPOINT_TAG" = "$tag_kind" ]; then
      image_id="$FAKE_FOREIGN_ID"
      owner=foreign
    fi
    case "$*" in
      *org.opencontainers.image.revision*) printf '%s\n' "$FAKE_IMAGE_REVISION" ;;
      *com.mqttsnet.thinglinks-edge.verifier-run*) printf '%s\n' "$owner" ;;
      *'{{.Id}}'*) printf '%s\n' "$image_id" ;;
    esac
    exit 0
    ;;
  image:rm)
    case "$last" in
      *builder*) tag_kind=builder ;;
      *offline*) tag_kind=offline ;;
      *) tag_kind=runtime ;;
    esac
    [ "$FAKE_IMAGE_RM_FAIL" != "$tag_kind" ] || exit 55
    [ "$FAKE_IMAGE_RM_STICKY" = "$tag_kind" ] || : > "$FAKE_STATE/$tag_kind-removed"
    exit 0
    ;;
  image:ls)
    case "$last" in
      *builder*) tag_kind=builder; image_id="$FAKE_BUILDER_ID" ;;
      *) tag_kind=runtime; image_id="$FAKE_RUNTIME_ID" ;;
    esac
    [ -f "$FAKE_STATE/$tag_kind-removed" ] || printf '%s\n' "$image_id"
    exit 0
    ;;
  build:*)
    case "$*" in *'--target builder'*) : > "$FAKE_STATE/builder-built" ;; *) : > "$FAKE_STATE/runtime-built" ;; esac
    exit 0
    ;;
  save:-o) : > "$3"; exit 0 ;;
  tag:*) : > "$FAKE_STATE/export-tagged"; exit 0 ;;
  inspect:*) owner="$FAKE_SEED_OWNER"; [ -n "$owner" ] || owner="$TLE_VERIFY_RUN_ID"; printf '%s\n' "$owner"; exit 0 ;;
  create:*) printf '%064d\n' 0 | tr 0 c; exit 0 ;;
  cp:*) exit 0 ;;
  rm:*) exit 0 ;;
  version:*) printf '%s\n' amd64; exit 0 ;;
  *) echo "unexpected docker command: $*" >&2; exit 91 ;;
esac
counter="$FAKE_STATE/$kind.seen"
if [ -f "$counter" ]; then suffix=after; else suffix=before; : > "$counter"; fi
command cat "$FAKE_STATE/$kind.$suffix"
`);

  executable(join(bin, 'git'), String.raw`
printf '%s\n' "$*" >> "$FAKE_LOG/git"
case "$*" in
  *'status --porcelain'*) printf '%s' "$FAKE_GIT_STATUS" ;;
  *'rev-parse HEAD'*) printf '%s\n' "$FAKE_GIT_HEAD" ;;
  *) echo "unexpected git command: $*" >&2; exit 94 ;;
esac
`);

  executable(join(bin, 'pnpm'), String.raw`
printf '%s\n' "$*" >> "$FAKE_LOG/pnpm"
if [ "$1" = test ] && [ "$FAKE_MANAGER_TEST_FAIL" = 1 ]; then
  echo '# tests 1'
  echo '# pass 0'
  echo '# fail 1'
  exit "$FAKE_MANAGER_TEST_STATUS"
fi
if [ "$1" = test ] && [ "$FAKE_PNPM_SIGNAL_DELAY" != 0 ]; then
  : > "$FAKE_STATE/pnpm-signal-ready"
  sleep "$FAKE_PNPM_SIGNAL_DELAY"
fi
echo '# tests 1'
echo '# pass 1'
echo '# fail 0'
`);

  executable(join(bin, 'node'), String.raw`
printf '%s|%s|%s|%s|%s\n' "$MANAGER_IMAGE" "$TLE_PLATFORM_RUNTIME_IMAGE" "$TLE_PLATFORM_BUILDER_IMAGE" "$TLE_PLATFORM_OFFLINE_BUNDLE" "$*" >> "$FAKE_LOG/node"
if [ -n "$FAKE_SILENT_VERIFIER" ]; then
  case "$*" in *"$FAKE_SILENT_VERIFIER"*) exit 0 ;; esac
fi
if [ "$FAKE_SILENT_EXACT_BUNDLE" = 1 ]; then
  case "$*" in
    *scripts/verify-offline-bundle.mjs*'--single-config-id'*) ;;
    *scripts/verify-offline-bundle.mjs*) exit 0 ;;
  esac
fi
case "$*" in *verify-2fa.mjs*) : > "$FAKE_STATE/cleanup-phase" ;; esac
case "$*" in
  *seed.test.ts*)
    echo '# tests 15'
    echo '# pass 15'
    echo '# fail 0'
    echo "# skipped $FAKE_ARTIFACT_SKIPPED"
    ;;
  *'--single-config-id'*) echo "$FAKE_CONFIG_ID" ;;
  *scripts/verify-offline-bundle.mjs*) echo "$FAKE_BUNDLE_CONTRACT_MARKER" ;;
  *) echo '1/1 通过' ;;
esac
`);

  executable(join(bin, 'bash'), String.raw`
printf '%s|%s\n' "$MANAGER_IMAGE" "$*" >> "$FAKE_LOG/bash"
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --out ]; then shift; out="$1"; fi
  shift
done
[ -n "$out" ] || exit 92
mkdir -p "$out"
case "$FAKE_BUNDLE_COUNT" in
  0) ;;
  1) : > "$out/thinglinks-edge-offline-test-linux-amd64.tar.gz" ;;
  2)
    : > "$out/thinglinks-edge-offline-test-a-linux-amd64.tar.gz"
    : > "$out/thinglinks-edge-offline-test-b-linux-amd64.tar.gz"
    ;;
  *) exit 93 ;;
esac
if [ "$FAKE_TAMPER_ARTIFACT" = 1 ]; then
  printf '%s\n' foreign-owner > "$(dirname "$out")/.tle-verify-owner"
fi
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_STATE: state,
    FAKE_RUNTIME_ID: IMMUTABLE_RUNTIME,
    FAKE_BUILDER_ID: IMMUTABLE_BUILDER,
    FAKE_FOREIGN_ID: IMMUTABLE_FOREIGN,
    FAKE_CONFIG_ID: IMMUTABLE_CONFIG,
    FAKE_INSPECT_FAIL: '0',
    FAKE_RUNTIME_ID_INSPECT_FAIL_ONCE: '0',
    FAKE_MANAGER_TEST_FAIL: '0',
    FAKE_MANAGER_TEST_STATUS: '42',
    FAKE_ARTIFACT_SKIPPED: '0',
    FAKE_RUNTIME_TAG_EXISTS: '0',
    FAKE_BUILDER_TAG_EXISTS: '0',
    FAKE_SEED_OWNER: '',
    FAKE_TAMPER_ARTIFACT: '0',
    FAKE_PNPM_SIGNAL_DELAY: '0',
    FAKE_SILENT_VERIFIER: '',
    FAKE_SILENT_EXACT_BUNDLE: '0',
    FAKE_BUNDLE_COUNT: '1',
    FAKE_BUNDLE_CONTRACT_MARKER: '1/1 通过',
    FAKE_GIT_HEAD: GIT_HEAD,
    FAKE_GIT_STATUS: '',
    FAKE_IMAGE_REVISION: GIT_HEAD,
    FAKE_REPOINT_TAG: '',
    FAKE_IMAGE_RM_FAIL: '',
    FAKE_IMAGE_RM_STICKY: '',
    TLE_VERIFY_RUN_ID: options.runId ?? 'entry-test-001',
  };
  delete env.MANAGER_IMAGE;
  delete env.TLE_PLATFORM_BUILDER_IMAGE;
  delete env.TLE_PLATFORM_RUNTIME_IMAGE;
  delete env.TLE_PLATFORM_OFFLINE_BUNDLE;
  Object.assign(env, options.env ?? {});

  return {
    root,
    log,
    run() {
      return spawnSync('/bin/sh', [VERIFY_ALL], { cwd: REPO, env, encoding: 'utf8' });
    },
    start() {
      return spawn('/bin/sh', [VERIFY_ALL], { cwd: REPO, env });
    },
    commands(name) {
      return lines(join(log, name));
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function mainVerifierInvocations(invocations) {
  return invocations.filter((line) => /\|scripts\/verify-[^|]+\.mjs(?: |$)/.test(line)
    && !line.includes('scripts/verify-offline-bundle.mjs'));
}

function assertCompleteVerifierRun(invocations) {
  const entry = readFileSync(VERIFY_ALL, 'utf8');
  const expected = (entry.match(/^run "/gm) ?? []).length;
  assert.equal(expected, 26, 'verify-all verifier inventory changed');
  const actual = mainVerifierInvocations(invocations);
  assert.equal(actual.length, expected, actual.join('\n'));
  for (const script of [
    'verify-container.mjs',
    'verify-compose.mjs',
    'verify-nodes.mjs',
    'verify-platform-nodes.mjs',
  ]) {
    assert.ok(actual.some((line) => line.includes(`scripts/${script}`)), `missing ${script}`);
  }
  return actual;
}

test('缺省入口只构建一次 runtime、准备同 checkout builder/离线包并传递不可变 ID', () => {
  const bed = fakeBed();
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const docker = bed.commands('docker');
    const runtimeBuilds = docker.filter((line) => line.startsWith('build ')
      && !line.includes('--target builder'));
    const builderBuilds = docker.filter((line) => line.startsWith('build ')
      && line.includes('--target builder'));
    assert.equal(runtimeBuilds.length, 1, docker.join('\n'));
    assert.equal(builderBuilds.length, 1, docker.join('\n'));
    assert.match(runtimeBuilds[0], /com\.mqttsnet\.thinglinks-edge\.verifier-run=entry-test-001/);
    assert.ok(docker.every((line) => !line.includes('line-1')), docker.join('\n'));
    const seedId = 'c'.repeat(64);
    assert.ok(docker.some((line) => line.startsWith('create --label ')
      && !line.includes('--name')), docker.join('\n'));
    assert.ok(docker.some((line) => line.startsWith(`inspect --format `)
      && line.endsWith(seedId)), docker.join('\n'));
    assert.ok(docker.some((line) => line.startsWith(`cp ${seedId}:/out/npm-seed/. `)),
      docker.join('\n'));
    const exportTag = 'thinglinks-edge-manager-verify:entry-test-001';
    assert.equal(docker.some((line) => line.startsWith('tag ')), false, docker.join('\n'));
    assert.ok(bed.commands('bash').every((line) => line.startsWith(`${exportTag}|`)),
      bed.commands('bash').join('\n'));
    const descriptorSave = docker.filter((line) => line.startsWith('save -o ')
      && line.endsWith(` ${IMMUTABLE_RUNTIME}`));
    assert.equal(descriptorSave.length, 1, docker.join('\n'));
    assert.notEqual(IMMUTABLE_RUNTIME, IMMUTABLE_CONFIG);
    for (const tag of [
      'thinglinks-edge-manager-verify:entry-test-001',
      'thinglinks-edge-manager-builder-verify:entry-test-001',
    ]) {
      assert.ok(docker.some((line) => line.includes('com.mqttsnet.thinglinks-edge.verifier-run')
        && line.endsWith(tag)), `missing ownership inspection for ${tag}\n${docker.join('\n')}`);
      assert.ok(docker.some((line) => line === `image rm ${tag}`),
        `missing cleanup for ${tag}\n${docker.join('\n')}`);
    }
    const runtimeOwnershipChecks = docker.filter((line) =>
      line.includes('com.mqttsnet.thinglinks-edge.verifier-run')
      && line.endsWith(exportTag));
    assert.equal(runtimeOwnershipChecks.length, 5,
      `runtime tag must be bound to descriptor before/after evidence and bundle\n${docker.join('\n')}`);

    const invocations = bed.commands('node');
    const artifact = invocations.find((line) => line.endsWith('src/core/nodes/seed.test.ts'));
    assert.ok(artifact, invocations.join('\n'));
    assert.ok(artifact.startsWith(
      `${IMMUTABLE_RUNTIME}|${IMMUTABLE_RUNTIME}|${IMMUTABLE_BUILDER}|`), artifact);
    const configProbe = invocations.filter((line) => line.includes('--single-config-id'));
    assert.equal(configProbe.length, 1, configProbe.join('\n'));
    const contract = invocations.filter((line) => line.includes('scripts/verify-offline-bundle.mjs')
      && !line.includes('--single-config-id'));
    assert.equal(contract.length, 1, contract.join('\n'));
    assert.match(contract[0], new RegExp(
      `scripts/verify-offline-bundle\\.mjs .* thinglinks-edge-manager-verify:entry-test-001 ${IMMUTABLE_CONFIG}$`));
    for (const testScript of [
      'scripts/verify-temp-parent.test.mjs',
      'scripts/build-offline-bundle.test.mjs',
      'scripts/verify-offline-bundle.test.mjs',
      'scripts/real-instance-fixture.test.mjs',
    ]) {
      assert.ok(invocations.some((line) => line.includes(testScript)), `missing ${testScript}`);
    }
    const realFixtureContracts = invocations.find((line) =>
      line.includes('scripts/real-instance-fixture.test.mjs')) ?? '';
    assert.match(realFixtureContracts, /scripts\/verify-api\.test\.mjs/);
    assert.match(realFixtureContracts, /scripts\/verify-compose\.test\.mjs/);
    assert.match(realFixtureContracts, /scripts\/verify-core-resource-ownership\.test\.mjs/);
    assert.match(realFixtureContracts, /scripts\/verify-cloud-resource-ownership\.test\.mjs/);
    assert.match(realFixtureContracts, /scripts\/verify-offline\.test\.mjs/);
    assert.match(realFixtureContracts, /scripts\/verifier-temp-lifecycle\.test\.mjs/);
    const containerVerifiers = assertCompleteVerifierRun(invocations);
    assert.ok(containerVerifiers.every((line) => line.startsWith(`${IMMUTABLE_RUNTIME}|`)),
      containerVerifiers.join('\n'));
  } finally {
    bed.cleanup();
  }
});

test('clean checkout 的显式 MANAGER_IMAGE revision 匹配 HEAD 时复用', () => {
  const bed = fakeBed({ env: { MANAGER_IMAGE: 'reviewed/manager:pr-17' } });
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const docker = bed.commands('docker');
    const runtimeBuilds = docker.filter((line) => line.startsWith('build ')
      && !line.includes('--target builder'));
    assert.equal(runtimeBuilds.length, 0, docker.join('\n'));
    assert.ok(docker.some((line) => line.includes('image inspect')
      && line.endsWith('reviewed/manager:pr-17')), docker.join('\n'));
    const containerVerifiers = assertCompleteVerifierRun(bed.commands('node'));
    assert.ok(containerVerifiers.every((line) => line.startsWith(`${IMMUTABLE_RUNTIME}|`)));
    assert.ok(bed.commands('bash').every((line) => line.startsWith('reviewed/manager:pr-17|')),
      bed.commands('bash').join('\n'));
    const contract = bed.commands('node')
      .filter((line) => line.includes('scripts/verify-offline-bundle.mjs')
        && !line.includes('--single-config-id'));
    assert.equal(contract.length, 1, contract.join('\n'));
    assert.ok(contract[0].endsWith(`reviewed/manager:pr-17 ${IMMUTABLE_CONFIG}`), contract[0]);
    assert.equal(docker.some((line) => line.includes('image rm reviewed/manager:pr-17')), false,
      docker.join('\n'));
  } finally {
    bed.cleanup();
  }
});

test('默认构建允许 dirty checkout 并仍构建当前工作树', () => {
  const bed = fakeBed({ env: { FAKE_GIT_STATUS: ' M tracked-file\n' } });
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(bed.commands('docker').filter((line) => line.startsWith('build ')
      && !line.includes('--target builder')).length, 1);
    assert.equal(bed.commands('git').some((line) => line.includes('status --porcelain')), false);
  } finally {
    bed.cleanup();
  }
});

test('显式 MANAGER_IMAGE 拒绝裸 sha256 ID', () => {
  const bed = fakeBed({ env: { MANAGER_IMAGE: IMMUTABLE_RUNTIME } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /named tag.*裸 ID\/digest/);
  } finally {
    bed.cleanup();
  }
});

test('外部 builder 与 offline bundle override 被忽略并始终自产同 checkout 制品', () => {
  const bed = fakeBed({
    env: {
      TLE_PLATFORM_BUILDER_IMAGE: 'foreign/builder:old',
      TLE_PLATFORM_OFFLINE_BUNDLE: '/foreign/bundle.tar.gz',
    },
  });
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(bed.commands('docker').filter((line) => line.startsWith('build --target builder')).length, 1);
    assert.ok(bed.commands('node').some((line) => line.includes('src/core/nodes/seed.test.ts')
      && line.includes(`|${IMMUTABLE_BUILDER}|`)));
    const artifactRuns = bed.commands('node').filter((line) =>
      line.includes('src/core/nodes/seed.test.ts') || line.includes('scripts/verify-offline-bundle.mjs'));
    assert.equal(artifactRuns.some((line) => line.includes('/foreign/bundle.tar.gz')), false);
  } finally {
    bed.cleanup();
  }
});

test('dirty checkout 拒绝显式 MANAGER_IMAGE override', () => {
  const bed = fakeBed({
    env: { MANAGER_IMAGE: 'reviewed/manager:pr-17', FAKE_GIT_STATUS: ' M tracked-file\n' },
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /工作区不干净.*MANAGER_IMAGE/);
    assert.equal(bed.commands('docker').filter((line) => line.startsWith('tag ')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('显式 MANAGER_IMAGE 的 OCI revision 旧于当前 HEAD 时失败', () => {
  const bed = fakeBed({
    env: { MANAGER_IMAGE: 'reviewed/manager:old', FAKE_IMAGE_REVISION: 'e'.repeat(40) },
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /OCI revision.*当前 HEAD/);
    assert.equal(bed.commands('docker').filter((line) => line.startsWith('tag ')).length, 0);
  } finally {
    bed.cleanup();
  }
});

for (const tagKind of ['runtime', 'builder']) {
  test(`${tagKind} task tag 删除失败会让本轮失败`, () => {
    const bed = fakeBed({ env: { FAKE_IMAGE_RM_FAIL: tagKind } });
    try {
      const result = bed.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /删除 task-owned 镜像 tag 失败/);
      assert.doesNotMatch(result.stdout, /全部通过/);
    } finally {
      bed.cleanup();
    }
  });
}

test('task tag 删除返回成功但 tag 仍存在时本轮失败', () => {
  const bed = fakeBed({ env: { FAKE_IMAGE_RM_STICKY: 'runtime' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /删除后仍存在/);
    assert.doesNotMatch(result.stdout, /全部通过/);
  } finally {
    bed.cleanup();
  }
});

test('cleanup 前 runtime export tag 被外部重指向时拒绝删除', () => {
  const bed = fakeBed({ env: { FAKE_REPOINT_TAG: 'runtime' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝删除 ownership 或 image ID 已变化/);
    const exportTag = 'thinglinks-edge-manager-verify:entry-test-001';
    assert.equal(bed.commands('docker').some((line) => line === `image rm ${exportTag}`), false);
  } finally {
    bed.cleanup();
  }
});

test('自动构建 tag 已存在时拒绝覆盖，也不会在 trap 删除外部 tag', () => {
  const bed = fakeBed({ env: { FAKE_RUNTIME_TAG_EXISTS: '1' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝覆盖/);
    const docker = bed.commands('docker');
    assert.equal(docker.filter((line) => line.startsWith('build ')).length, 0);
    assert.equal(docker.filter((line) => line.startsWith('image rm ')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('manager 单测失败码不会被摘要管道吞掉', () => {
  const bed = fakeBed({ env: { FAKE_MANAGER_TEST_FAIL: '1', FAKE_MANAGER_TEST_STATUS: '42' } });
  try {
    const result = bed.run();
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.equal(bed.commands('node').length, 0);
    assert.equal(bed.commands('docker').filter((line) => line.startsWith('build ')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('显式镜像无法解析时在真容器 verifier 前失败', () => {
  const bed = fakeBed({
    env: { MANAGER_IMAGE: 'missing/manager:bad', FAKE_INSPECT_FAIL: '1' },
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /镜像不存在或不可检查/);
    assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('runtime build 已落 tag 但紧随的 ID inspect 失败时仍按本轮 label 回收 tag', () => {
  const bed = fakeBed({ env: { FAKE_RUNTIME_ID_INSPECT_FAIL_ONCE: '1' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const tag = 'thinglinks-edge-manager-verify:entry-test-001';
    const docker = bed.commands('docker');
    assert.ok(docker.some((line) => line === `image rm ${tag}`), docker.join('\n'));
    assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('生产制品 seed.test 仍有 skip 时 gate 失败', () => {
  const bed = fakeBed({ env: { FAKE_ARTIFACT_SKIPPED: '3' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /生产制品用例仍有 skip/);
    assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
  } finally {
    bed.cleanup();
  }
});

for (const count of ['0', '2']) {
  test(`offline bundle 产物数量为 ${count} 时 gate 失败`, () => {
    const bed = fakeBed({ env: { FAKE_BUNDLE_COUNT: count } });
    try {
      const result = bed.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /offline bundle 产物数量不是 1/);
      assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
    } finally {
      bed.cleanup();
    }
  });
}

test('verifier 静默 exit 0 但没有唯一通过 marker 时 gate 失败', () => {
  const bed = fakeBed({ env: { FAKE_SILENT_VERIFIER: 'verify-container-guard.mjs' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /容器参数白名单.*失败/);
    assert.match(result.stdout, /缺少唯一成功 marker/);
    assert.doesNotMatch(result.stdout, /全部通过/);
  } finally {
    bed.cleanup();
  }
});

test('exact bundle validator 静默 exit 0 时在主 verifier 前失败', () => {
  const bed = fakeBed({ env: { FAKE_SILENT_EXACT_BUNDLE: '1' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /exact offline bundle 契约失败.*marker 0/);
    assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('exact bundle validator 输出 0/0 通过时仍在主 verifier 前失败', () => {
  const bed = fakeBed({ env: { FAKE_BUNDLE_CONTRACT_MARKER: '0/0 通过' } });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /exact offline bundle 契约未全绿：0\/0 通过/);
    assert.equal(mainVerifierInvocations(bed.commands('node')).length, 0);
  } finally {
    bed.cleanup();
  }
});

test('seed 导出容器 ownership 不匹配时拒绝 cp 和 rm 外部 immutable ID', () => {
  const bed = fakeBed({ env: { FAKE_SEED_OWNER: 'foreign' } });
  try {
    const result = bed.run();
    const seedId = 'c'.repeat(64);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /seed 导出容器缺少本次运行 ownership/);
    const docker = bed.commands('docker');
    assert.equal(docker.some((line) => line.startsWith(`cp ${seedId}:`)), false);
    assert.equal(docker.some((line) => line === `rm -f ${seedId}`), false);
  } finally {
    bed.cleanup();
  }
});

async function waitFor(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
}

test('HUP、INT、TERM 始终保留标准非零退出码并经过 EXIT cleanup', async (t) => {
  for (const [signal, expected] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
    await t.test(signal, async () => {
      const bed = fakeBed({ env: { FAKE_PNPM_SIGNAL_DELAY: '0.4' } });
      try {
        const child = bed.start();
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        await waitFor(join(bed.root, 'state', 'pnpm-signal-ready'));
        assert.equal(child.kill(signal), true);
        const outcome = await new Promise((resolveClose, rejectClose) => {
          const timeout = setTimeout(() => rejectClose(new Error(`timeout waiting for ${signal}`)), 5000);
          child.once('close', (code, closeSignal) => {
            clearTimeout(timeout);
            resolveClose({ code, signal: closeSignal });
          });
        });
        assert.deepEqual(outcome, { code: expected, signal: null }, `${stdout}\n${stderr}`);
      } finally {
        bed.cleanup();
      }
    });
  }
});

test('临时制品目录 ownership marker 被替换时拒绝递归清理并令入口失败', () => {
  const bed = fakeBed({ env: { FAKE_TAMPER_ARTIFACT: '1' } });
  let artifactRoot;
  try {
    const result = bed.run();
    const bundleCommand = bed.commands('bash')[0] ?? '';
    const out = bundleCommand.match(/--out ([^ ]+)/)?.[1];
    artifactRoot = out ? dirname(out) : undefined;
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝清理不属于本次运行的临时目录/);
    assert.ok(artifactRoot && readFileSync(join(artifactRoot, '.tle-verify-owner'), 'utf8')
      .includes('foreign-owner'));
  } finally {
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
    bed.cleanup();
  }
});

test('CI 独占 Docker 模式会拦截任意新增容器、卷或网络', () => {
  const bed = fakeBed({
    containersAfter: 'container-new\n',
    volumesAfter: 'volume-new\n',
    networksAfter: 'network-new\n',
    env: { TLE_VERIFY_EXCLUSIVE_DOCKER: '1' },
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /新增容器 1 · 卷 1 · 网络 1/);
    assert.match(result.stdout, /存在失败/);
    const snapshots = bed.commands('docker').filter((line) => /^(ps|volume|network) /.test(line));
    assert.deepEqual(snapshots, [
      'ps -aq',
      'volume ls -q',
      'network ls -q',
      'ps -aq',
      'volume ls -q',
      'network ls -q',
    ]);
  } finally {
    bed.cleanup();
  }
});

test('共享 Docker 主机忽略同期新增的无关资源', () => {
  const bed = fakeBed({
    containersAfter: 'external-container\tLibreChat\tcom.example.stack=librechat\n',
    volumesAfter: 'librechat-data\tcom.example.stack=librechat\n',
    networksAfter: 'external-network\tlibrechat_default\tcom.example.stack=librechat\n',
  });
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /新增容器 0 · 卷 0 · 网络 0/);
  } finally {
    bed.cleanup();
  }
});

test('共享 Docker 主机仍拦截 ThingLinks 命名或标签范围内的残留', () => {
  const bed = fakeBed({
    containersAfter: 'container-new\ttle-orphan\tcom.example.stack=test\n',
    volumesAfter: 'volume-new\tcom.mqttsnet.thinglinks-edge.managed=true\n',
    networksAfter: 'network-new\trandom-network\tcom.mqttsnet.thinglinks-edge.verifier-run=entry-test-001\n',
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /新增容器 1 · 卷 1 · 网络 1/);
    assert.match(result.stdout, /存在失败/);
  } finally {
    bed.cleanup();
  }
});

test('既有 Docker 基线 ID 前后相同时零残留且入口不删除基线资源', () => {
  const baseline = {
    containersBefore: 'baseline-container-id\ttle-baseline\t\n',
    containersAfter: 'baseline-container-id\ttle-baseline\t\n',
    volumesBefore: 'tle-baseline-volume\tcom.mqttsnet.thinglinks-edge.managed=true\n',
    volumesAfter: 'tle-baseline-volume\tcom.mqttsnet.thinglinks-edge.managed=true\n',
    networksBefore: 'baseline-network-id\ttle-baseline-network\t\n',
    networksAfter: 'baseline-network-id\ttle-baseline-network\t\n',
  };
  const bed = fakeBed(baseline);
  try {
    const result = bed.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /新增容器 0 · 卷 0 · 网络 0/);
    const docker = bed.commands('docker');
    for (const id of ['baseline-container-id', 'tle-baseline-volume', 'baseline-network-id']) {
      assert.equal(docker.some((line) => (
        /^(?:rm|image rm|volume rm|network rm) /.test(line) && line.includes(id)
      )), false,
        docker.join('\n'));
    }
  } finally {
    bed.cleanup();
  }
});

test('共享 Docker 主机的既有 ThingLinks 资源丢失会让 gate 失败', () => {
  const bed = fakeBed({
    containersBefore: 'baseline-container-id\ttle-baseline\t\n',
    volumesBefore: 'tle-baseline-volume\tcom.mqttsnet.thinglinks-edge.managed=true\n',
    networksBefore: 'baseline-network-id\ttle-baseline-network\t\n',
  });
  try {
    const result = bed.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /丢失容器 1 · 卷 1 · 网络 1/);
    assert.match(result.stdout, /存在失败/);
  } finally {
    bed.cleanup();
  }
});

test('GitHub Actions 直接复用入口并运行入口回归，不在 workflow 另建 Manager 镜像', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  assert.equal((workflow.match(/run:\s+pnpm verify/g) ?? []).length, 1);
  assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+pull_request:/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:/);
  assert.equal((workflow.match(/docker (?:build|compose .*build)/g) ?? []).length, 0);
  assert.match(workflow, /node --test apps\/manager\/scripts\/verify-all\.test\.mjs/);
  assert.match(workflow, /apps\/manager\/scripts\/build-offline-bundle\.test\.mjs/);
  assert.match(workflow, /TLE_VERIFY_EXCLUSIVE_DOCKER:\s*['"]?1['"]?/);
  assert.match(workflow, /docker pull nodered\/node-red:4\.1\.13-22-minimal/);
  assert.match(workflow, /docker pull alpine\/socat@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(workflow, /docker pull alpine\/socat\s*(?:\n|$)/);
  for (const testScript of [
    'real-instance-fixture.test.mjs',
    'verify-api.test.mjs',
    'verify-compose.test.mjs',
    'verify-core-resource-ownership.test.mjs',
    'verify-cloud-resource-ownership.test.mjs',
    'verify-offline.test.mjs',
    'verifier-temp-lifecycle.test.mjs',
  ]) assert.match(workflow, new RegExp(`apps/manager/scripts/${testScript.replaceAll('.', '\\.')}`));
  assert.match(workflow, /apps\/manager\/scripts\/verify-offline-bundle\.test\.mjs/);
});

test('跨平台 verifier 导入测试排在 manager build 之后', () => {
  const entry = readFileSync(VERIFY_ALL, 'utf8');
  const build = entry.indexOf('pnpm build');
  const tempTest = entry.indexOf('node --test scripts/verify-temp-parent.test.mjs');
  assert.ok(build >= 0, 'missing manager build command');
  assert.ok(tempTest >= 0, 'missing temp-parent regression command');
  assert.ok(build < tempTest);
});
