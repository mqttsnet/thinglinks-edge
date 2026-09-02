import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo } from '../instance/repo.ts';
import { createBackup, restoreBackup, readManifest, keyFingerprint, BackupError } from './backup.ts';

const KEY = deriveKey('master-a', 'salt');
const OTHER = deriveKey('master-b', 'salt');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tle-bk-'));
  const dataRoot = join(root, 'data');
  const instRoot = join(dataRoot, 'instances');
  await mkdir(join(instRoot, 'line-a'), { recursive: true });
  await writeFile(join(instRoot, 'line-a', 'flows.json'), '[{"id":"n1"}]');
  await writeFile(join(instRoot, 'line-a', 'settings.js'), 'module.exports={};');

  const db = openDb(join(dataRoot, 'manager', 'edge.db'));
  const repo = new InstanceRepo(db, KEY);
  repo.create(
    { id: 'line-a', name: '一号线', imageTag: 'tag', memLimit: 512, cpuLimit: 0.5,
      adminRoot: '/red/line-a/', credSecret: 'cs', notes: '' },
    [], [{ username: 'admin', password: 'super-secret-pw', permissions: '*' }],
  );
  return { root, dataRoot, instRoot, db, repo };
}

test('备份含清单、库快照与实例数据', async () => {
  const f = await fixture();
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  const m = readManifest(tar);
  assert.equal(m.product, 'thinglinks-edge');
  assert.equal(m.schemaVersion, 2);
  assert.deepEqual(m.instances.map((i) => i.id), ['line-a']);
  assert.equal(m.masterKeyFingerprint, keyFingerprint(KEY));
  f.db.close();
  await rm(f.root, { recursive: true, force: true });
});

test('库用一致性快照，WAL 里的数据不会丢', async () => {
  // 直接拷 edge.db 会拿到缺数据的库，而且打得开、看着正常
  const f = await fixture();
  f.repo.create(
    { id: 'line-b', name: '二号线', imageTag: 'tag', memLimit: 512, cpuLimit: 0.5,
      adminRoot: '/red/line-b/', credSecret: 'cs2', notes: '' },
    [], [{ username: 'admin', password: 'pw-b', permissions: '*' }],
  );
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  f.db.close();

  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });
  const db2 = openDb(join(target, 'manager', 'edge.db'));
  const ids = db2.prepare('SELECT id FROM instance ORDER BY id').all().map((r: any) => r.id);
  assert.deepEqual(ids, ['line-a', 'line-b'], '刚写入、可能还在 WAL 里的记录必须在');
  db2.close();
  await rm(f.root, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('异机恢复：同一 MASTER_KEY 下实例凭据仍能解开', async () => {
  const f = await fixture();
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  f.db.close();

  // 模拟另一台机器：全新目录
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });

  const db2 = openDb(join(target, 'manager', 'edge.db'));
  const repo2 = new InstanceRepo(db2, KEY);
  assert.equal(repo2.credentials('line-a')[0]!.password, 'super-secret-pw',
               '凭据解不开就等于实例起不来');
  assert.equal(await readFile(join(target, 'instances', 'line-a', 'flows.json'), 'utf8'),
               '[{"id":"n1"}]', '流程文件也要跟着回来');
  db2.close();
  await rm(f.root, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('MASTER_KEY 不符时拒绝恢复，并说清后果', async () => {
  const f = await fixture();
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2, instances: [],
  });
  f.db.close();
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  await assert.rejects(() => restoreBackup({ archive: tar, dataRoot: target, key: OTHER }),
                       /MASTER_KEY 与备份不符/);
  // 明知凭据会失效时可强行恢复
  const m = await restoreBackup({ archive: tar, dataRoot: target, key: OTHER, ignoreKeyMismatch: true });
  assert.equal(m.masterKeyFingerprint, keyFingerprint(KEY));
  await rm(f.root, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('恢复时清掉旧的 WAL 残留', async () => {
  const f = await fixture();
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2, instances: [],
  });
  f.db.close();
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  await mkdir(join(target, 'manager'), { recursive: true });
  await writeFile(join(target, 'manager', 'edge.db-wal'), 'stale');
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });
  // 旧 -wal 会把恢复出来的库拖回旧状态
  await assert.rejects(() => readFile(join(target, 'manager', 'edge.db-wal')));
  await rm(f.root, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

test('非本平台或格式不符的归档被拒', async () => {
  const { tarArchive } = await import('./tar.ts');
  assert.throws(() => readManifest(tarArchive([{ name: 'a.txt', content: 'x' }])),
                /没有 manifest.json/);
  assert.throws(() => readManifest(tarArchive([
    { name: 'manifest.json', content: '{"product":"other","format":1}' }])), /不是本平台/);
  assert.throws(() => readManifest(tarArchive([
    { name: 'manifest.json', content: '{"product":"thinglinks-edge","format":99}' }])), /格式版本/);
});

test('归档含目录穿越路径时拒绝写入', async () => {
  const { tarArchive } = await import('./tar.ts');
  const evil = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
        product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
        instances: [], schemaVersion: 2, createdAt: '' }) },
    { name: 'instances/../../etc/passwd', content: 'pwned' },
  ]);
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  await assert.rejects(() => restoreBackup({ archive: evil, dataRoot: target, key: KEY }),
                       BackupError);
  await rm(target, { recursive: true, force: true });
});

test('PAX path 还原出的目录穿越同样被恢复边界拒绝', async () => {
  const { tarArchive } = await import('./tar.ts');
  const evil = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
        product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
        instances: [], schemaVersion: 2, createdAt: '' }) },
    { name: `instances/../../${'x'.repeat(124)}`, content: 'pwned' },
  ]);
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-pax-'));
  await assert.rejects(() => restoreBackup({ archive: evil, dataRoot: target, key: KEY }),
    BackupError);
  await rm(target, { recursive: true, force: true });
});
