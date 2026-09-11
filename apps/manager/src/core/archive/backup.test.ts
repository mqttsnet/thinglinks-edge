import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo } from '../instance/repo.ts';
import { createBackup, restoreBackup, readManifest, keyFingerprint, BackupError } from './backup.ts';

const KEY = deriveKey('master-a', 'salt');
const OTHER = deriveKey('master-b', 'salt');

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tle-bk-'));
  const dataRoot = join(root, 'data');
  const instRoot = join(dataRoot, 'instances');
  await mkdir(join(instRoot, 'line-a'), { recursive: true });
  await writeFile(join(instRoot, 'line-a', 'flows.json'), '[{"id":"n1"}]');
  await writeFile(join(instRoot, 'line-a', 'settings.js'), 'module.exports={};');

  const db = openDb(join(dataRoot, 'manager', 'edge.db'));
  t.after(async () => {
    if (db.open) db.close();
    await rm(root, { recursive: true, force: true });
  });
  const repo = new InstanceRepo(db, KEY);
  repo.create(
    { id: 'line-a', name: '一号线', imageTag: 'tag', memLimit: 512, cpuLimit: 0.5,
      adminRoot: '/red/line-a/', credSecret: 'cs', notes: '' },
    [], [{ username: 'admin', password: 'super-secret-pw', permissions: '*' }],
  );
  return { root, dataRoot, instRoot, db, repo };
}

test('备份含清单、库快照与实例数据', async (t) => {
  const f = await fixture(t);
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  const m = readManifest(tar, KEY);
  assert.equal(m.product, 'thinglinks-edge');
  assert.equal(m.schemaVersion, 2);
  assert.deepEqual(m.instances.map((i) => i.id), ['line-a']);
  assert.equal(m.masterKeyFingerprint, keyFingerprint(KEY));
  f.db.close();
});

test('新备份会认证加密完整归档，离线持有者不能读取流程机密或清单', async (t) => {
  const f = await fixture(t);
  const flowSecret = 'flow-only-backup-secret';
  await writeFile(
    join(f.instRoot, 'line-a', 'flows.json'),
    JSON.stringify([{ id: 'n1', password: flowSecret }]),
  );
  const archive = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });

  assert.equal(archive.includes(Buffer.from(flowSecret)), false);
  assert.equal(archive.includes(Buffer.from('manifest.json')), false);
  assert.throws(() => readManifest(archive), /加密备份.*密钥/);
  assert.equal(readManifest(archive, KEY).product, 'thinglinks-edge');

  const target = await mkdtemp(join(tmpdir(), 'tle-rs-encrypted-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await assert.rejects(
    () => restoreBackup({ archive, dataRoot: target, key: OTHER }),
    /备份解密失败/,
  );
  await restoreBackup({ archive, dataRoot: target, key: KEY });
  assert.equal(
    await readFile(join(target, 'instances', 'line-a', 'flows.json'), 'utf8'),
    JSON.stringify([{ id: 'n1', password: flowSecret }]),
  );

  f.db.close();
});

test('库用一致性快照，WAL 里的数据不会丢', async (t) => {
  // 直接拷 edge.db 会拿到缺数据的库，而且打得开、看着正常
  const f = await fixture(t);
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
  t.after(() => rm(target, { recursive: true, force: true }));
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });
  const db2 = openDb(join(target, 'manager', 'edge.db'));
  const ids = db2.prepare('SELECT id FROM instance ORDER BY id').all().map((r: any) => r.id);
  assert.deepEqual(ids, ['line-a', 'line-b'], '刚写入、可能还在 WAL 里的记录必须在');
  db2.close();
});

test('异机恢复：同一 MASTER_KEY 下实例凭据仍能解开', async (t) => {
  const f = await fixture(t);
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  f.db.close();

  // 模拟另一台机器：全新目录
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });

  const db2 = openDb(join(target, 'manager', 'edge.db'));
  const repo2 = new InstanceRepo(db2, KEY);
  assert.equal(repo2.credentials('line-a')[0]!.password, 'super-secret-pw',
               '凭据解不开就等于实例起不来');
  assert.equal(await readFile(join(target, 'instances', 'line-a', 'flows.json'), 'utf8'),
               '[{"id":"n1"}]', '流程文件也要跟着回来');
  db2.close();
});

test('新加密备份的错误密钥不能由 force 绕过', async (t) => {
  const f = await fixture(t);
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2, instances: [],
  });
  f.db.close();
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await assert.rejects(() => restoreBackup({ archive: tar, dataRoot: target, key: OTHER }),
                       /备份解密失败/);
  await assert.rejects(
    () => restoreBackup({ archive: tar, dataRoot: target, key: OTHER, ignoreKeyMismatch: true }),
    /备份解密失败/,
  );
});

test('旧版明文 TAR 仅允许在显式 force 下跳过密钥指纹检查', async (t) => {
  const { tarArchive } = await import('./tar.ts');
  const legacy = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
      product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
      instances: [], schemaVersion: 2, createdAt: '',
    }) },
    { name: 'manager/edge.db', content: 'legacy-snapshot' },
  ]);
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-legacy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await assert.rejects(
    () => restoreBackup({ archive: legacy, dataRoot: target, key: OTHER }),
    /MASTER_KEY 与备份不符/,
  );
  const manifest = await restoreBackup({
    archive: legacy, dataRoot: target, key: OTHER, ignoreKeyMismatch: true,
  });
  assert.equal(manifest.format, 1);
  assert.equal(await readFile(join(target, 'manager', 'edge.db'), 'utf8'), 'legacy-snapshot');
});

test('恢复时清掉旧的 WAL 残留', async (t) => {
  const f = await fixture(t);
  const tar = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2, instances: [],
  });
  f.db.close();
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await mkdir(join(target, 'manager'), { recursive: true });
  await writeFile(join(target, 'manager', 'edge.db-wal'), 'stale');
  await restoreBackup({ archive: tar, dataRoot: target, key: KEY });
  // 旧 -wal 会把恢复出来的库拖回旧状态
  await assert.rejects(() => readFile(join(target, 'manager', 'edge.db-wal')));
});

test('非本平台或格式不符的归档被拒', async () => {
  const { tarArchive } = await import('./tar.ts');
  assert.throws(() => readManifest(tarArchive([{ name: 'a.txt', content: 'x' }])),
                /没有 manifest.json/);
  assert.throws(() => readManifest(tarArchive([
    { name: 'manifest.json', content: '{"product":"other","format":1}' }])), /不是本平台/);
  assert.throws(() => readManifest(tarArchive([
    { name: 'manifest.json', content: '{"product":"thinglinks-edge","format":99}' }])), /格式版本/);
  assert.throws(() => readManifest(tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
      product: 'thinglinks-edge', format: 2, masterKeyFingerprint: keyFingerprint(KEY),
      instances: [], schemaVersion: 2, createdAt: '',
    }) },
  ])), /必须使用加密封装/);
});

test('归档含目录穿越路径时拒绝写入', async (t) => {
  const { tarArchive } = await import('./tar.ts');
  const evil = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
        product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
        instances: [], schemaVersion: 2, createdAt: '' }) },
    { name: 'instances/../../etc/passwd', content: 'pwned' },
  ]);
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await assert.rejects(() => restoreBackup({ archive: evil, dataRoot: target, key: KEY }),
                       BackupError);
});

test('PAX path 还原出的目录穿越同样被恢复边界拒绝', async (t) => {
  const { tarArchive } = await import('./tar.ts');
  const evil = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
        product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
        instances: [], schemaVersion: 2, createdAt: '' }) },
    { name: `instances/../../${'x'.repeat(124)}`, content: 'pwned' },
  ]);
  const target = await mkdtemp(join(tmpdir(), 'tle-rs-pax-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await assert.rejects(() => restoreBackup({ archive: evil, dataRoot: target, key: KEY }),
    BackupError);
});

for (const scope of ['实例根目录', '嵌套目录'] as const) {
  test(`备份安全回归：${scope}读取失败必须终止备份`, async (t) => {
    const f = await fixture(t);
    const unreadable = scope === '实例根目录'
      ? join(f.instRoot, 'line-a')
      : join(f.instRoot, 'line-a', 'context');
    await mkdir(unreadable, { recursive: true });
    await writeFile(join(unreadable, 'required.json'), '{"required":true}');
    const code = scope === '实例根目录' ? 'EACCES' : 'EIO';
    const originalReaddir = fsPromises.readdir;
    let injected = false;
    t.mock.method(fsPromises, 'readdir', async (...args: Parameters<typeof originalReaddir>) => {
      if (String(args[0]) === unreadable) {
        injected = true;
        throw Object.assign(new Error(`${code}: cannot read directory`), { code });
      }
      return Reflect.apply(originalReaddir, fsPromises, args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    await assert.rejects(() => createBackup({
      db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
      instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
    }), '不能把读取失败当作空目录生成成功备份');
    assert.equal(injected, true, '必须实际触发目录读取故障');
  });
}

test('备份安全回归：清单声明的实例目录缺失必须终止备份', async (t) => {
  const f = await fixture(t);
  await rm(join(f.instRoot, 'line-a'), { recursive: true });
  await assert.rejects(() => createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  }), '缺失实例数据不能以完整备份的形式返回');
});

test('备份安全回归：归档后段非法时正式数据库与流程必须保持原样', async (t) => {
  const { tarArchive } = await import('./tar.ts');
  const f = await fixture(t);
  f.db.close();
  const databaseBefore = await readFile(join(f.dataRoot, 'manager', 'edge.db'));
  const flowPath = join(f.instRoot, 'line-a', 'flows.json');
  const flowBefore = await readFile(flowPath);
  const archive = tarArchive([
    { name: 'manifest.json', content: JSON.stringify({
      product: 'thinglinks-edge', format: 1, masterKeyFingerprint: keyFingerprint(KEY),
      instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
      schemaVersion: 2, createdAt: '2026-09-07T00:00:00.000Z',
    }) },
    { name: 'manager/edge.db', content: 'replacement-database' },
    { name: 'instances/line-a/flows.json', content: '[{"id":"replacement"}]' },
    { name: 'instances/../../escaped.txt', content: 'must-not-be-written' },
  ]);

  await assert.rejects(() => restoreBackup({ archive, dataRoot: f.dataRoot, key: KEY }));
  assert.equal((await readFile(join(f.dataRoot, 'manager', 'edge.db'))).equals(databaseBefore), true,
    '拒绝归档必须保留整个旧数据库');
  assert.deepEqual(await readFile(flowPath), flowBefore,
    '拒绝归档必须保留整个旧实例数据');
  await assert.rejects(() => readFile(join(f.root, 'escaped.txt')), { code: 'ENOENT' });
});

for (const scope of ['文件', '实例目录', '数据根目录'] as const) {
  test(`备份安全回归：目标${scope}符号链接不会把恢复写到数据根外`, async (t) => {
    const f = await fixture(t);
    const archive = await createBackup({
      db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
      instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
    });
    const target = join(f.root, 'restore');
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    const outsideFile = scope === '数据根目录'
      ? join(outside, 'instances', 'line-a', 'flows.json')
      : join(outside, 'flows.json');
    await mkdir(join(outsideFile, '..'), { recursive: true });
    await writeFile(outsideFile, 'outside-sentinel');
    const link = scope === '数据根目录'
      ? target
      : scope === '实例目录'
        ? join(target, 'instances', 'line-a')
        : join(target, 'instances', 'line-a', 'flows.json');
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(scope === '文件' ? outsideFile : outside, link);

    // A private staging restore may safely replace an in-root symlink, or reject
    // it. Both policies must leave the external target unchanged; a symlink root
    // must always be rejected because it is not a trustworthy transaction root.
    if (scope === '数据根目录') {
      await assert.rejects(() => restoreBackup({ archive, dataRoot: target, key: KEY }));
      assert.equal((await lstat(target)).isSymbolicLink(), true);
    } else {
      try {
        await restoreBackup({ archive, dataRoot: target, key: KEY });
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }
    assert.equal(await readFile(outsideFile, 'utf8'), 'outside-sentinel',
      '恢复不得修改数据根之外的文件');
  });
}

test('备份安全回归：成功恢复完整替换旧快照，不保留已删除文件或旧实例', async (t) => {
  const f = await fixture(t);
  const archive = await createBackup({
    db: f.db, key: KEY, instanceDataRoot: f.instRoot, schemaVersion: 2,
    instances: [{ id: 'line-a', name: '一号线', imageTag: 'tag' }],
  });
  const target = join(f.root, 'restore');
  await mkdir(join(target, 'instances', 'line-a'), { recursive: true });
  await mkdir(join(target, 'instances', 'obsolete-line'));
  await writeFile(join(target, 'instances', 'line-a', 'removed.json'), 'stale-context');
  await writeFile(join(target, 'instances', 'obsolete-line', 'flows.json'), 'stale-instance');

  await restoreBackup({ archive, dataRoot: target, key: KEY });

  assert.equal(await readFile(join(target, 'instances', 'line-a', 'flows.json'), 'utf8'),
    '[{"id":"n1"}]');
  await assert.rejects(() => lstat(join(target, 'instances', 'line-a', 'removed.json')),
    { code: 'ENOENT' }, '旧快照已删除的文件不能混入恢复结果');
  await assert.rejects(() => lstat(join(target, 'instances', 'obsolete-line')),
    { code: 'ENOENT' }, '旧快照独有实例不能混入恢复结果');
});
