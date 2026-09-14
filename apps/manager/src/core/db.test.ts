import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from './db.ts';
import { InstanceRepo } from './instance/repo.ts';

test('v12 database upgrades instance runtime and journal idempotently through current migrations', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, 12);
  db.prepare(
    'INSERT INTO instance '
      + '(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret,notes) '
      + 'VALUES (?,?,?,?,?,?,?,?)',
  ).run('line-a', 'Line A', '5.0.4-24-minimal', 512, 0.5,
    '/red/line-a/', 'secret', 'preserve me');

  assert.equal(migrate(db), 21);
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
  const executionColumns = db.prepare(
    `SELECT name, dflt_value, "notnull" AS required
     FROM pragma_table_info('instance_node_migration')
     WHERE name IN ('execution_owner', 'execution_lease_expires_at')
     ORDER BY name`,
  ).all();
  assert.deepEqual(executionColumns, [
    { name: 'execution_lease_expires_at', dflt_value: '0', required: 1 },
    { name: 'execution_owner', dflt_value: "''", required: 1 },
  ]);
  assert.equal(migrate(db), 21);
  const preserved = db.prepare(
    'SELECT name, notes FROM instance WHERE id = ?',
  ).get('line-a') as { name: string; notes: string };
  assert.deepEqual(preserved, { name: 'Line A', notes: 'preserve me' });
});

test('migration target is validated and never downgrades a newer database', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrate(db, -1), /目标版本/);
  assert.throws(() => migrate(db, 13.5), /目标版本/);
  assert.throws(() => migrate(db, 22), /目标版本/);
  assert.equal(migrate(db), 21);
  assert.equal(migrate(db, 12), 21);
  assert.equal(
    (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
    21,
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

test('revised v13 execution ownership defaults and constraints are enforced', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare(
    `INSERT INTO instance
      (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('line-a', 'Line A', '5.0.4-24-minimal', 512, 0.5, '/red/line-a/', 'secret', '');
  const insert = db.prepare(
    `INSERT INTO instance_node_migration
      (instance_id, tx_id, operation_kind, phase, original_running, staged_before,
       mode_before, image_id_before, target_integrity, checkpoint_dir,
       snapshot_json, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'line-a', 'tx-bootstrap', 'bootstrap', 'preparing', 0, 0, 'legacy',
    'sha256:image-a', 'sha512:a', '', '{"version":1,"kind":"bootstrap"}', 'admin',
  );
  assert.deepEqual(
    db.prepare(
      `SELECT execution_owner, execution_lease_expires_at
       FROM instance_node_migration WHERE instance_id = 'line-a'`,
    ).get(),
    { execution_owner: '', execution_lease_expires_at: 0 },
  );

  db.prepare("DELETE FROM instance_node_migration WHERE instance_id = 'line-a'").run();
  const insertOwned = db.prepare(
    `INSERT INTO instance_node_migration
      (instance_id, tx_id, operation_kind, phase, original_running, staged_before,
       mode_before, image_id_before, target_integrity, checkpoint_dir,
       snapshot_json, actor, execution_owner, execution_lease_expires_at)
     VALUES (?, ?, 'migration', 'preparing', 1, 0, 'legacy', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertOwned.run(
    'line-a', 'tx-owned', 'sha256:image-a', 'sha512:a',
    '.thinglinks-migration/line-a/tx-owned',
    '{"version":1,"kind":"migration"}', 'admin', 'owner-valid-0001', 10_000,
  );
  db.prepare("DELETE FROM instance_node_migration WHERE instance_id = 'line-a'").run();

  for (const [owner, expiresAt] of [
    ['bad owner', 10_000],
    ['owner-valid-0001', 0],
    ['owner-valid-0001', 1.5],
    ['', 10_000],
  ] as const) {
    assert.throws(
      () => insertOwned.run(
        'line-a', `tx-invalid-${expiresAt}-${owner.length}`, 'sha256:image-a', 'sha512:a',
        '.thinglinks-migration/line-a/tx-invalid',
        '{"version":1,"kind":"migration"}', 'admin', owner, expiresAt,
      ),
      /CHECK constraint failed/,
    );
  }
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


test('v14 template metadata migration preserves existing content and supplies custom defaults', () => {
  const db = new Database(':memory:');
  migrate(db, 13);
  db.prepare("INSERT INTO flow_template(id,name,content) VALUES ('old','Legacy','[]')").run();
  migrate(db);
  assert.deepEqual(db.prepare("SELECT name,content,category,protocols FROM flow_template WHERE id='old'").get(), {
    name: 'Legacy', content: '[]', category: 'custom', protocols: '[]',
  });
  migrate(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM flow_template').get() as { n: number }).n, 1);
  db.close();
});


test('v15 adds trusted copy metadata without changing existing template categories or content', () => {
  const db = new Database(':memory:');
  migrate(db, 14);
  db.prepare("INSERT INTO flow_template(id,name,content,category,protocols) VALUES ('old','Site','[]','network','[\"tcp\"]')").run();
  migrate(db);
  assert.deepEqual(db.prepare("SELECT name,content,category,protocols,trusted_metadata FROM flow_template WHERE id='old'").get(), {
    name: 'Site', content: '[]', category: 'network', protocols: '["tcp"]', trusted_metadata: '{}',
  });
  db.close();
});


test('v18 adds durable protocol cleanup intents without changing instance data',()=>{
 const db=new Database(':memory:');migrate(db,18);
 db.prepare('INSERT INTO editor_origin(instance_id,generation,port) VALUES(?,?,?)').run('preserved','generation',20001);
 assert.equal(migrate(db),21);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM editor_origin').get() as {n:number}).n,1);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM protocol_diagnostic').get() as {n:number}).n,0);
 db.close();
});

test('v20 observer generation fences upgrade without changing existing device data and cascade only with their instance', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrate(db, 19);
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  db.prepare("INSERT INTO field_device(instance_id,node_id,name,online,last_seen) VALUES('i','d','D',1,'2026-09-13T00:00:00Z')").run();
  assert.equal(migrate(db), 21);
  assert.deepEqual(db.prepare("SELECT online,last_seen FROM field_device WHERE instance_id='i'").get(), { online: 1, last_seen: '2026-09-13T00:00:00Z' });
  db.prepare("INSERT INTO presence_observer_device(instance_id,node_id) VALUES('i','d')").run();
  db.prepare("INSERT INTO presence_observer(instance_id,node_id,observer_id) VALUES('i','d','observer')").run();
  db.prepare("INSERT INTO presence_observer_run(instance_id,node_id,observer_id,run_nonce,expected_revision,ticket,ticket_expires_at) VALUES('i','d','observer','run',0,'ticket',30000)").run();
  assert.throws(() => db.prepare("UPDATE presence_observer SET state='unverified-positive'").run(), /CHECK/);
  db.prepare("DELETE FROM instance WHERE id='i'").run();
  assert.equal((db.prepare('SELECT count(*) n FROM presence_observer_run').get() as { n: number }).n, 0);
  db.close();
});
