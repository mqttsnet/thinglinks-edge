import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allocateLoopbackPort,
  cleanupOwnedTempAreas,
  closeVerifierResources,
  createOwnedTempArea,
  removeOwnedTempArea,
  resolveCanonicalTempParent,
} from './_owned-temp.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const targets = [
  'verify-security.mjs',
  'verify-diag.mjs',
  'verify-setup.mjs',
  'verify-2fa.mjs',
];

test('shared owned-temp helper exists', () => {
  assert.equal(existsSync(join(SCRIPT_DIR, '_owned-temp.mjs')), true);
});

for (const script of targets) {
  test(`${script} owns every temporary root and cleans it in finally`, () => {
    const source = readFileSync(join(SCRIPT_DIR, script), 'utf8');
    assert.match(source, /createOwnedTempArea/);
    assert.match(source, /cleanupOwnedTempAreas/);
    assert.match(source, /finally/);
    assert.doesNotMatch(source, /mkdtempSync|tmpdir\(\)/);
  });

  test(`${script} uses a dynamic loopback port`, () => {
    const source = readFileSync(join(SCRIPT_DIR, script), 'utf8');
    assert.match(source, /allocateLoopbackPort/);
    assert.doesNotMatch(source, /const PORT = 13\d{3}/);
  });
}

test('security owns both its primary DB and restore destination', () => {
  const source = readFileSync(join(SCRIPT_DIR, 'verify-security.mjs'), 'utf8');
  assert.match(source, /createOwnedTempArea\('sec'/);
  assert.match(source, /createOwnedTempArea\('sec-restore'/);
});

test('diagnostics closes server, cloud, spool, and DB before temporary cleanup', () => {
  const source = readFileSync(join(SCRIPT_DIR, 'verify-diag.mjs'), 'utf8');
  assert.match(source, /closeVerifierResources/);
  assert.match(source, /spool.*close/s);
  assert.match(source, /db.*close/s);
});

test('setup tracks all three independently started apps for exceptional cleanup', () => {
  const source = readFileSync(join(SCRIPT_DIR, 'verify-setup.mjs'), 'utf8');
  assert.match(source, /startedApps/);
  assert.match(source, /for \(const runtime of \[\.\.\.startedApps\]\.reverse\(\)\)/);
});

test('owned temp area uses an allowed canonical parent, random prefix, and out-of-data marker', () => {
  const area = createOwnedTempArea('2fa', {
    outerRunId: 'entry-test-001',
    randomToken: '0123456789ab',
  });
  try {
    assert.ok(area.parent === '/private/tmp' || area.parent === '/tmp');
    assert.ok(area.root.startsWith(`${area.parent}/tle-2fa-0123456789ab.`));
    assert.equal(area.marker.startsWith(`${area.dataDir}/`), false);
    assert.equal(readFileSync(area.marker, 'utf8'), 'entry-test-001\n0123456789ab\n');
  } finally {
    removeOwnedTempArea(area);
  }
});

test('canonical parent resolver rejects an escaped realpath', () => {
  assert.throws(() => resolveCanonicalTempParent({
    existsSync: () => true,
    realpathSync: () => '/var/tmp',
  }), /escapes allowed boundary/);
});

test('recursive cleanup removes owned DB/spool artifacts', () => {
  const area = createOwnedTempArea('unit', {
    outerRunId: 'entry-test-002',
    randomToken: 'abcdef012345',
  });
  const artifact = join(area.dataDir, 'edge.db');
  writeFileSync(artifact, 'fixture');
  const areas = [area];
  cleanupOwnedTempAreas(areas);
  assert.equal(areas.length, 0);
  assert.equal(existsSync(area.root), false);
  assert.equal(existsSync(artifact), false);
});

test('owned temp initialization failure after marker creation cleans its exact root', () => {
  let createdRoot = '';
  assert.throws(() => createOwnedTempArea('unit', {
    outerRunId: 'entry-test-init-failure',
    randomToken: '999999999999',
    adapters: {
      mkdtempSync(prefix) {
        createdRoot = mkdtempSync(prefix);
        return createdRoot;
      },
      mkdirSync() {
        throw new Error('injected data-dir failure');
      },
    },
  }), /injected data-dir failure/);
  assert.ok(createdRoot);
  assert.equal(existsSync(createdRoot), false);
});

test('marker owner, symlink, and hardlink attacks all block recursive deletion', () => {
  const cases = [
    (area) => writeFileSync(area.marker, 'external\n'),
    (area) => {
      const outside = `${area.root}.outside`;
      writeFileSync(outside, area.ownerText);
      rmSync(area.marker);
      symlinkSync(outside, area.marker);
      return () => rmSync(outside, { force: true });
    },
    (area) => {
      const alias = `${area.marker}.alias`;
      linkSync(area.marker, alias);
      return () => rmSync(alias, { force: true });
    },
  ];
  for (const [index, attack] of cases.entries()) {
    const area = createOwnedTempArea('unit', {
      outerRunId: 'entry-test-003',
      randomToken: `00000000000${index}`,
    });
    let restoreExtra;
    try {
      restoreExtra = attack(area);
      assert.throws(() => removeOwnedTempArea(area), /marker changed/);
      assert.equal(existsSync(area.root), true);
    } finally {
      restoreExtra?.();
      rmSync(area.marker, { force: true });
      writeFileSync(area.marker, area.ownerText);
      removeOwnedTempArea(area);
    }
  }
});

test('batch cleanup removes other owned areas but reports a tampered owner', () => {
  const owned = createOwnedTempArea('unit', {
    outerRunId: 'entry-test-004', randomToken: '111111111111',
  });
  const tampered = createOwnedTempArea('unit', {
    outerRunId: 'entry-test-004', randomToken: '222222222222',
  });
  writeFileSync(tampered.marker, 'external\n');
  const areas = [owned, tampered];
  try {
    assert.throws(() => cleanupOwnedTempAreas(areas), /verifier temp cleanup failed/);
    assert.equal(existsSync(owned.root), false);
    assert.equal(existsSync(tampered.root), true);
    assert.deepEqual(areas, [tampered]);
  } finally {
    writeFileSync(tampered.marker, tampered.ownerText);
    cleanupOwnedTempAreas(areas);
  }
});

test('resource cleanup preserves order and continues after one close failure', async () => {
  const calls = [];
  await assert.rejects(closeVerifierResources([
    { label: 'server', close: async () => { calls.push('server'); throw new Error('boom'); } },
    { label: 'spool', close: async () => { calls.push('spool'); } },
    { label: 'db', close: () => { calls.push('db'); } },
  ]), /verifier resource cleanup failed/);
  assert.deepEqual(calls, ['server', 'spool', 'db']);
});

test('dynamic loopback allocator returns a valid ephemeral port', async () => {
  const port = await allocateLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
});
