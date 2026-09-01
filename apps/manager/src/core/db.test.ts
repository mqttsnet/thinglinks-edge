import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from './db.ts';
import { InstanceRepo } from './instance/repo.ts';

test('v12 database upgrades existing instance and journal to v13 idempotently', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, 12);
  db.prepare(
    'INSERT INTO instance '
      + '(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret,notes) '
      + 'VALUES (?,?,?,?,?,?,?,?)',
  ).run('line-a', 'Line A', '5.0.4-24-minimal', 512, 0.5,
    '/red/line-a/', 'secret', 'preserve me');

  assert.equal(migrate(db), 13);
  const runtime = new InstanceRepo(db, Buffer.alloc(32, 1)).nodeRuntime('line-a');
  assert.deepEqual(runtime, {
    mode: 'legacy',
    platformVersion: '',
    migrationState: 'idle',
    migrationError: 'none',
  });
  const journalCount = db.prepare(
    'SELECT COUNT(*) AS n FROM instance_node_migration',
  ).get() as { n: number };
  assert.equal(journalCount.n, 0);
  assert.equal(migrate(db), 13);
  const preserved = db.prepare(
    'SELECT name, notes FROM instance WHERE id = ?',
  ).get('line-a') as { name: string; notes: string };
  assert.deepEqual(preserved, { name: 'Line A', notes: 'preserve me' });
});

test('migration target is validated and never downgrades a newer database', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, -1), /目标版本/);
  assert.throws(() => migrate(db, 13.5), /目标版本/);
  assert.throws(() => migrate(db, 14), /目标版本/);
  assert.equal(migrate(db), 13);
  assert.equal(migrate(db, 12), 13);
  assert.equal(
    (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
    13,
  );
});

test('v13 journal has an enforced instance foreign key', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  assert.throws(() => db.prepare(
    `INSERT INTO instance_node_migration
      (instance_id, tx_id, operation_kind, phase, original_running, staged_before,
       mode_before, image_id_before, target_integrity, checkpoint_dir, snapshot_json, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'missing', 'tx-01', 'migration', 'preparing', 0, 0, 'legacy',
    'sha256:image-a', 'sha512:a', '.thinglinks-migration/missing/tx-01', '{}', 'admin',
  ), /FOREIGN KEY/);
});

test('v13 rejects arbitrary migration error text in journal and projection', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare(
    `INSERT INTO instance
      (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('line-a', 'Line A', '5.0.4-24-minimal', 512, 0.5, '/red/line-a/', 'secret', '');
  assert.throws(
    () => db.prepare('UPDATE instance SET node_migration_error = ? WHERE id = ?')
      .run('opaque-secret-value', 'line-a'),
    /CHECK constraint failed/,
  );
  assert.throws(() => db.prepare(
    `INSERT INTO instance_node_migration
      (instance_id, tx_id, operation_kind, phase, original_running, staged_before,
       mode_before, image_id_before, target_integrity, checkpoint_dir,
       snapshot_json, actor, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'line-a', 'tx-01', 'migration', 'preparing', 0, 0, 'legacy',
    'sha256:image-a', 'sha512:a', '.thinglinks-migration/line-a/tx-01',
    JSON.stringify({ version: 1, kind: 'migration' }), 'admin', 'opaque-secret-value',
  ), /CHECK constraint failed/);
});
