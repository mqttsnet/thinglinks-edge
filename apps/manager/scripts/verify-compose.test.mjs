import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
