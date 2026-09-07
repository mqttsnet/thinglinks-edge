import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, keyFingerprint, restoreBackup } from './backup.ts';
import { openDb } from '../db.ts';
import { tarArchive, type TarEntry } from './tar.ts';

const key = Buffer.alloc(32, 1);
const snapshot = { name: 'manager/edge.db', content: 'snapshot' };
const manifest = {
  product: 'thinglinks-edge', format: 1, createdAt: '2026-09-07T00:00:00.000Z',
  schemaVersion: 2, masterKeyFingerprint: keyFingerprint(key),
  instances: [{ id: 'line-a', name: 'A', imageTag: 'tag' }],
};

const cases: [string, TarEntry[]][] = [
  ['duplicate database', [snapshot, snapshot]],
  ['missing database', [{ name: 'instances/line-a/flows.json', content: 'flow' }]],
  ['absolute path', [snapshot, { name: '/instances/line-a/x', content: '' }]],
  ['dot alias', [snapshot, { name: 'instances/line-a/./x', content: '' }]],
  ['empty component', [snapshot, { name: 'instances/line-a//x', content: '' }]],
  ['backslash', [snapshot, { name: 'instances/line-a/a\\b', content: '' }]],
  ['unknown instance', [snapshot, { name: 'instances/line-b/x', content: '' }]],
  ['manager configuration', [snapshot, { name: 'manager/npm/config', content: '' }]],
  ['file directory conflict', [snapshot,
    { name: 'instances/line-a/x', content: '' },
    { name: 'instances/line-a/x/child', content: '' }]],
];

for (const [label, entries] of cases) {
  test(`restore validates ${label} before modifying live data`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'tle-restore-validate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'manager'));
    await writeFile(join(root, 'manager', 'edge.db'), 'old');
    await assert.rejects(() => restoreBackup({
      key, dataRoot: root,
      archive: tarArchive([{ name: 'manifest.json', content: JSON.stringify(manifest) }, ...entries]),
    }));
    assert.equal(await readFile(join(root, 'manager', 'edge.db'), 'utf8'), 'old');
    assert.deepEqual(await readdir(root), ['manager']);
  });
}

test('explicitly excluded node_modules is not read while other directory errors remain fatal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tle-backup-excluded-'));
  const db = openDb(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const excluded = join(root, 'line-a', 'node_modules');
  await mkdir(excluded, { recursive: true });
  await writeFile(join(root, 'line-a', 'flows.json'), 'flow');
  const original = fs.readdir;
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === excluded) throw new Error('excluded directory must not be traversed');
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const archive = await createBackup({
    db, key, instanceDataRoot: root, instances: manifest.instances,
    schemaVersion: 2, excludeNodeModules: true,
  });
  assert.ok(archive.length > 0);
});
