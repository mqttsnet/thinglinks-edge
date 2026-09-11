import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'verify-compose.mjs');

test('Compose verifier reserves a host port only for Manager and keeps instance fixtures internal', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const allocationCalls = (source.match(/\ballocatePort\(\)/g) ?? []).length - 1;
  const instanceRequests = [...source.matchAll(
    /body: JSON\.stringify\(\{ id: (?:BROKEN_)?ID,[\s\S]*?ports: (\[[^\n]*\])/g,
  )];

  assert.equal(allocationCalls, 1, 'only the Manager listener may reserve a host port');
  assert.equal(instanceRequests.length, 2, 'both historical and healthy instance fixtures are covered');
  assert.deepEqual(
    instanceRequests.map((match) => match[1]),
    ['[]', '[]'],
    'Compose-only checks must not race on unrelated instance host-port bindings',
  );
  assert.doesNotMatch(source, /\b(?:HEALTHY|BROKEN)_PORT\b/);
});

test('healthy bootstrap completes before the historical instance network is corrupted', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const brokenCreate = source.indexOf('const brokenCreated = await fetch');
  const healthyCreate = source.indexOf('const created = await fetch');
  const detachManager = source.indexOf('.disconnect({ Container: info.Id, Force: true })');
  const foreignContainer = source.indexOf('const foreignContainer = await raw.createContainer');

  assert.ok(brokenCreate >= 0 && healthyCreate >= 0 && detachManager >= 0 && foreignContainer >= 0);
  assert.ok(brokenCreate < healthyCreate, 'the historical row must remain first for restart recovery');
  assert.ok(
    healthyCreate < detachManager && healthyCreate < foreignContainer,
    'corrupting Manager networking must not interfere with the independent healthy bootstrap',
  );
});

test('both instance networks prove the Manager registry alias resolves to their own endpoint', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const probes = (source.match(/probeInstanceRegistry\([^)]+\)/g) ?? [])
    .filter((call) => call.includes('.Id'));

  assert.deepEqual(probes, [
    'probeInstanceRegistry(brokenContainer.Id, info.Id, brokenNetwork)',
    'probeInstanceRegistry(healthyContainer.Id, info.Id, netInfo)',
  ]);
  assert.match(source, /network\.Containers\?\.\[managerContainerId\]/);
  assert.match(source, /sh\(\['exec', instanceContainerId,/);
});

test('Compose verifier pins Node-RED repo and removes a polluted parent-shell override', () => {
  const source = readFileSync(SCRIPT, 'utf8');

  assert.match(source, /'NODE_RED_IMAGE_REPO'/);
  assert.match(source, /`NODE_RED_IMAGE_REPO=nodered\/node-red`/);
});

test('init-data 不创建无用的 Compose default network', () => {
  const compose = readFileSync(join(dirname(SCRIPT), '../../../docker-compose.yml'), 'utf8');
  const initBlock = compose.slice(compose.indexOf('  init-data:'), compose.indexOf('\n  manager:'));
  assert.match(initBlock, /network_mode:\s*none/);
  assert.doesNotMatch(initBlock, /\n\s+networks:/);
});

test('顶部自选密码经过真实 Compose 解析后保持特殊字符且关闭匿名认领', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'tle-compose-password-'));
  try {
    const password = 'fixture}-$HOME-${VALUE}-#-:-"-password';
    const source = readFileSync(join(dirname(SCRIPT), '../../../docker-compose.yml'), 'utf8');
    const edited = source.replace(/^x-initial-password: &initial-password ""$/m,
      () => `x-initial-password: &initial-password ${JSON.stringify(password.replaceAll('$', () => '$$'))}`);
    assert.notEqual(edited, source, 'the password is edited as a quoted scalar, not inside interpolation syntax');
    const file = join(root, 'compose.yml');
    const envFile = join(root, 'empty.env');
    writeFileSync(file, edited, { mode: 0o600 });
    writeFileSync(envFile, '', { mode: 0o600 });
    const parsed = JSON.parse(execFileSync('docker', [
      'compose', '-f', file, '--env-file', envFile, 'config', '--format', 'json',
    ], { encoding: 'utf8', env: { PATH: process.env.PATH } }));
    // Normalized Compose output escapes dollars for round-trip serialization.
    // verify-compose.mjs also logs in with a literal special-character password.
    assert.equal(parsed.services.manager.environment.COMPOSE_INITIAL_PASSWORD.replaceAll('$$', '$'), password);
    assert.equal(parsed.services.manager.environment.INITIAL_PASSWORD, '');
    assert.equal(parsed.services.manager.environment.ADMIN_SETUP_MODE, 'password');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
