import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, recordAudit } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo, RepoError, type InstanceRecord, type PortRecord } from './repo.ts';
import { PLATFORM_NODE_PACKAGE } from '../nodes/platform-contract.ts';

const KEY = deriveKey('test-master', 'salt');
const TEST_EXECUTION_OWNER = 'owner-migration-tests-0001';
const TEST_EXECUTION_NOW = 1_000;
const fresh = () => new InstanceRepo(openDb(':memory:'), KEY);

const rec = (over: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id: 'line-a', name: '一号产线', imageTag: '5.0.4-24-minimal',
  memLimit: 512, cpuLimit: 0.5, adminRoot: '/red/line-a/',
  credSecret: 'cs', notes: '', ...over,
});
const port = (over: Partial<PortRecord> = {}): PortRecord => ({
  hostPort: 30001, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1', purpose: 'MQTT', ...over,
});
const cred = () => [{ username: 'admin', password: 'p@ss-1', permissions: '*' as const }];

const fileFact = (seed: string, exists = true) => exists
  ? { exists: true as const, sha256: seed.repeat(64) }
  : { exists: false as const };

const migrationSnapshot = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  kind: 'migration' as const,
  settings: fileFact('a'),
  flows: fileFact('b'),
  credentials: fileFact('c'),
  packageManifest: fileFact('d'),
  lock: fileFact('e'),
  legacyManifestSha256: 'f'.repeat(64),
  nodeInventorySha256: '1'.repeat(64),
  ...over,
});

const bootstrapSnapshot = () => ({ version: 1 as const, kind: 'bootstrap' as const });

const migrationBegin = (
  instanceId: string,
  txId: string,
  over: Record<string, unknown> = {},
) => ({
  instanceId,
  txId,
  operationKind: 'migration' as const,
  phase: 'preparing' as const,
  originalRunning: true,
  stagedBefore: false,
  modeBefore: 'legacy' as const,
  imageIdBefore: 'sha256:image-a',
  targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
  checkpointDir: `.thinglinks-migration/${instanceId}/${txId}`,
  snapshot: migrationSnapshot(),
  actor: 'admin',
  executionOwner: TEST_EXECUTION_OWNER,
  executionLeaseExpiresAt: 10_000,
  ...over,
});

const bootstrapBegin = (instanceId: string, txId: string) => ({
  instanceId,
  txId,
  operationKind: 'bootstrap' as const,
  phase: 'preparing' as const,
  originalRunning: false,
  stagedBefore: false,
  modeBefore: 'legacy' as const,
  imageIdBefore: 'sha256:image-a',
  targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
  checkpointDir: '',
  snapshot: bootstrapSnapshot(),
  actor: 'admin',
});

test('迁移可重复执行且幂等', () => {
  const db = openDb(':memory:');
  const v = migrate(db);
  assert.equal(migrate(db), v, '再次迁移不应改变版本');
  assert.ok(v >= 1);
});

test('创建后可读回，字段完整', () => {
  const repo = fresh();
  repo.create(rec(), [port()], cred());
  const got = repo.get('line-a');
  assert.equal(got?.name, '一号产线');
  assert.equal(got?.adminRoot, '/red/line-a/');
  assert.equal(got?.cpuLimit, 0.5);
  assert.equal(repo.nodeRuntime('line-a')?.mode, 'legacy');
});

test('重复 id 被拒绝', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  assert.throws(() => repo.create(rec(), [], cred()), RepoError);
});

test('无账号时拒绝创建', () => {
  assert.throws(() => fresh().create(rec(), [], []), /至少需要一个/);
});

test('实例凭据可逆 —— 免密跳转需要明文换 token', () => {
  const repo = fresh();
  repo.create(rec(), [], [{ username: 'admin', password: '明文口令-!@#', permissions: '*' }]);
  assert.equal(repo.credentials('line-a')[0]?.password, '明文口令-!@#');
});

test('库里存的是密文而非明文', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], [{ username: 'admin', password: 'plain-secret', permissions: '*' }]);
  const raw = db.prepare('SELECT pwd_enc FROM instance_cred').get() as { pwd_enc: string };
  assert.ok(!raw.pwd_enc.includes('plain-secret'), '数据库中不得出现明文口令');
  assert.match(raw.pwd_enc, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
});

test('重置口令后取到新值', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.resetCredential('line-a', 'admin', 'new-pass');
  assert.equal(repo.credentials('line-a')[0]?.password, 'new-pass');
  assert.throws(() => repo.resetCredential('line-a', 'nobody', 'x'), RepoError);
});

test('宿主端口冲突时报出占用方', () => {
  const repo = fresh();
  repo.create(rec(), [port({ hostPort: 30001 })], cred());
  repo.create(rec({ id: 'line-b', adminRoot: '/red/line-b/' }), [], cred());
  assert.throws(
    () => repo.bindPort('line-b', port({ hostPort: 30001 })),
    (e: unknown) => {
      assert.match((e as Error).message, /已被实例 line-a 占用/);
      return true;
    },
  );
});

test('端口可列举，已用端口表含归属', () => {
  const repo = fresh();
  repo.create(rec(), [port({ hostPort: 30001 }), port({ hostPort: 30002, containerPort: 502 })], cred());
  assert.equal(repo.ports('line-a').length, 2);
  assert.equal(repo.usedPorts().get(30002), 'line-a');
});

test('删除实例级联清掉端口与凭据', () => {
  const repo = fresh();
  repo.create(rec(), [port()], cred());
  repo.remove('line-a');
  assert.equal(repo.get('line-a'), undefined);
  assert.equal(repo.usedPorts().size, 0, '端口应随实例释放');
  assert.equal(repo.credentials('line-a').length, 0);
  assert.throws(() => repo.remove('line-a'), RepoError);
});

test('创建失败时整体回滚，不留半条记录', () => {
  const repo = fresh();
  repo.create(rec(), [port({ hostPort: 30001 })], cred());
  assert.throws(() => repo.create(
    rec({ id: 'line-b', adminRoot: '/red/line-b/' }),
    [port({ hostPort: 30001 })],  // 与 line-a 冲突
    cred(),
  ), RepoError);
  assert.equal(repo.get('line-b'), undefined, '冲突后不应残留实例记录');
});

test('npm bootstrap instance row and preparing journal are created in one SQLite transaction', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  const bootstrap = {
    ...bootstrapBegin('line-a', 'tx-bootstrap-create'),
    modeBefore: 'npm' as const,
  };

  repo.createWithNodeMigration(
    rec({ nodeRuntimeMode: 'npm' }),
    [port()],
    cred(),
    bootstrap,
  );

  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'npm',
    platformVersion: '',
    migrationState: 'preparing',
    migrationError: 'none',
  });
  assert.deepEqual(repo.nodeMigration('line-a')?.snapshot, bootstrapSnapshot());
  assert.equal(repo.ports('line-a').length, 1);
  assert.equal(repo.credentials('line-a').length, 1);
});

test('failed bootstrap journal insert rolls back the instance row ports and credentials', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  db.exec(`CREATE TRIGGER reject_bootstrap_journal BEFORE INSERT ON instance_node_migration
    BEGIN SELECT RAISE(ABORT, 'bootstrap journal rejected'); END;`);

  assert.throws(
    () => repo.createWithNodeMigration(
      rec({ nodeRuntimeMode: 'npm' }),
      [port()],
      cred(),
      {
        ...bootstrapBegin('line-a', 'tx-bootstrap-rejected'),
        modeBefore: 'npm',
      },
    ),
    /bootstrap journal rejected/,
  );
  assert.equal(repo.get('line-a'), undefined);
  assert.equal(repo.ports('line-a').length, 0);
  assert.equal(repo.credentials('line-a').length, 0);
  assert.equal(repo.nodeMigration('line-a'), undefined);
});

test('审计可写入且带时间戳', () => {
  const db = openDb(':memory:');
  recordAudit(db, { actor: 'admin', action: 'create-instance', target: 'line-a', result: 'ok' });
  const row = db.prepare('SELECT * FROM audit').get() as Record<string, unknown>;
  assert.equal(row['actor'], 'admin');
  assert.ok(String(row['ts']).length > 0);
});

test('journal phase and instance projection update and commit atomically', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, Buffer.alloc(32, 1));
  repo.create({
    id: 'line-a',
    name: 'Line A',
    imageTag: '5.0.4-24-minimal',
    memLimit: 512,
    cpuLimit: 0.5,
    adminRoot: '/red/line-a/',
    credSecret: 'secret',
    notes: '',
    nodeRuntimeMode: 'legacy',
  }, [], [{ username: 'admin', password: 'pass', permissions: '*' }]);
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-sync'));
  repo.updateNodeMigration('line-a', 'verifying');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'legacy',
    platformVersion: '',
    migrationState: 'verifying',
    migrationError: 'none',
  });
  assert.equal(repo.nodeMigration('line-a')?.phase, 'verifying');
  repo.commitNodeMigration('line-a', '0.0.1', 'admin');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'npm', platformVersion: '0.0.1',
    migrationState: 'committed', migrationError: 'none',
  });
  assert.equal(repo.nodeMigration('line-a')?.phase, 'committed');
  const audit = db.prepare(
    "SELECT actor, target FROM audit WHERE action = 'commit-node-migration'",
  ).get() as { actor: string; target: string };
  assert.deepEqual(audit, { actor: 'admin', target: 'line-a' });
});

test('journal round-trips versioned migration and bootstrap snapshots without secrets', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.create(rec({ id: 'line-b', adminRoot: '/red/line-b/' }), [], cred());
  const snapshot = migrationSnapshot({ credentials: fileFact('c', false) });
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-01', { snapshot }));
  repo.beginNodeMigration(bootstrapBegin('line-b', 'tx-bootstrap'));
  const journal = repo.nodeMigration('line-a');
  assert.deepEqual(journal?.snapshot, snapshot);
  assert.deepEqual(repo.nodeMigration('line-b')?.snapshot, bootstrapSnapshot());
  assert.doesNotMatch(JSON.stringify(journal), /token|password|secret|npmrc/i);
});

test('startup projection mismatch becomes manual_required', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-recover'));
  db.prepare(
    "UPDATE instance SET node_migration_state = 'verifying', node_migration_error = 'verification' WHERE id = 'line-a'",
  ).run();

  const reopened = new InstanceRepo(db, KEY);
  assert.equal(reopened.nodeRuntime('line-a')?.migrationState, 'manual_required');
  assert.equal(reopened.nodeMigration('line-a')?.phase, 'manual_required');
  assert.equal(reopened.nodeMigration('line-a')?.error, 'state-inconsistent');
  assert.equal(
    reopened.nodeRuntime('line-a')?.migrationError,
    reopened.nodeMigration('line-a')?.error,
  );
});

test('phase update rolls back journal when projection update fails', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-atomic'));
  db.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE ON instance
    WHEN NEW.node_migration_state = 'verifying'
    BEGIN SELECT RAISE(ABORT, 'projection rejected'); END;`);
  assert.throws(() => repo.updateNodeMigration('line-a', 'verifying', 'verification'), /projection rejected/);
  assert.equal(repo.nodeMigration('line-a')?.phase, 'preparing');
  assert.equal(repo.nodeRuntime('line-a')?.migrationState, 'preparing');
});

test('final commit rolls back journal and projection when audit fails', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-commit'));
  repo.updateNodeMigration('line-a', 'verifying');
  db.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON audit
    WHEN NEW.action = 'commit-node-migration'
    BEGIN SELECT RAISE(ABORT, 'audit rejected'); END;`);
  assert.throws(() => repo.commitNodeMigration('line-a', '0.0.1', 'admin'), /audit rejected/);
  assert.equal(repo.nodeMigration('line-a')?.phase, 'verifying');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'legacy', platformVersion: '', migrationState: 'verifying', migrationError: 'none',
  });
});

test('begin accepts only preparing and validates mode against the persisted projection', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  const valid = migrationBegin('line-a', 'tx-valid');
  assert.throws(
    () => repo.beginNodeMigration({ ...valid, phase: 'committed' as 'preparing' }),
    RepoError,
  );
  assert.throws(
    () => repo.beginNodeMigration({ ...valid, modeBefore: 'npm' }),
    /运行模式/,
  );
  assert.equal(repo.nodeMigration('line-a'), undefined);
});

test('begin validates ids paths enums and bootstrap empty-checkpoint facts', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  const valid = migrationBegin('line-a', 'tx-valid');
  assert.throws(() => repo.beginNodeMigration({ ...valid, txId: '../escape' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '/tmp/checkpoint' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '../checkpoint' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, operationKind: 'invalid' as 'migration' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, modeBefore: 'invalid' as 'legacy' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...bootstrapBegin('line-a', 'tx-bootstrap'), originalRunning: true }), RepoError);
  assert.equal(repo.nodeMigration('line-a'), undefined);
});

test('snapshot union requires exact bootstrap shape and complete existence-aware migration facts', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  const invalidSnapshots = [
    { version: 1, kind: 'bootstrap', env: { NPM_TOKEN: 'opaque' } },
    { version: 1, kind: 'migration' },
    migrationSnapshot({ settings: { exists: true } }),
    migrationSnapshot({ flows: { exists: false, sha256: 'a'.repeat(64) } }),
    migrationSnapshot({ nodeInventorySha256: 'short' }),
    migrationSnapshot({ rawInventory: ['tl-device'] }),
  ];
  for (const [i, snapshot] of invalidSnapshots.entries()) {
    assert.throws(
      () => repo.beginNodeMigration(migrationBegin('line-a', `tx-invalid-${i}`, { snapshot })),
      RepoError,
    );
  }
  assert.throws(
    () => repo.beginNodeMigration({
      ...bootstrapBegin('line-a', 'tx-bootstrap-extra'),
      snapshot: { ...bootstrapSnapshot(), env: { NPM_TOKEN: 'opaque' } },
    }),
    RepoError,
  );
  assert.throws(
    () => repo.beginNodeMigration({ ...bootstrapBegin('line-a', 'tx-kind'), snapshot: migrationSnapshot() }),
    RepoError,
  );
  assert.equal(repo.nodeMigration('line-a'), undefined);
});

test('journal and projection persist only closed migration error codes', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-error'));
  assert.throws(
    () => repo.updateNodeMigration('line-a', 'manual_required', 'opaque-secret-value' as 'verification'),
    RepoError,
  );
  assert.equal(repo.nodeMigration('line-a')?.error, 'none');
  assert.equal(repo.nodeRuntime('line-a')?.migrationError, 'none');
  repo.updateNodeMigration('line-a', 'manual_required', 'verification');
  assert.equal(repo.nodeMigration('line-a')?.error, 'verification');
  assert.equal(repo.nodeRuntime('line-a')?.migrationError, 'verification');
});

test('identical same-tx begin is idempotent but changed same-tx facts reject', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  const input = migrationBegin('line-a', 'tx-idempotent');
  repo.beginNodeMigration(input);
  const before = repo.nodeMigration('line-a');
  repo.beginNodeMigration(input);
  assert.deepEqual(repo.nodeMigration('line-a'), before);
  assert.throws(() => repo.beginNodeMigration({ ...input, actor: 'other-admin' }), RepoError);
  assert.deepEqual(repo.nodeMigration('line-a'), before);
});

test('global tx collision and a different active tx are rejected', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.create(rec({ id: 'line-b', adminRoot: '/red/line-b/' }), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-shared'));
  assert.throws(() => repo.beginNodeMigration(migrationBegin('line-b', 'tx-shared')), RepoError);
  assert.throws(() => repo.beginNodeMigration(migrationBegin('line-a', 'tx-other')), RepoError);
  assert.equal(repo.nodeMigration('line-b'), undefined);
  assert.equal(repo.nodeMigration('line-a')?.txId, 'tx-shared');
});

test('committed dirty and manual journals reject a fresh begin', () => {
  for (const [instanceId, terminal] of [
    ['line-committed', 'committed'],
    ['line-dirty', 'rolled_back_dirty'],
    ['line-manual', 'manual_required'],
  ] as const) {
    const repo = fresh();
    repo.create(rec({ id: instanceId, adminRoot: `/red/${instanceId}/` }), [], cred());
    repo.beginNodeMigration(migrationBegin(instanceId, `tx-${terminal}`));
    if (terminal === 'committed') {
      repo.updateNodeMigration(instanceId, 'verifying');
      repo.commitNodeMigration(instanceId, '0.0.1', 'admin');
    } else {
      repo.updateNodeMigration(instanceId, terminal, terminal === 'manual_required' ? 'state-inconsistent' : 'rollback');
    }
    assert.throws(() => repo.beginNodeMigration(migrationBegin(instanceId, `tx-retry-${terminal}`)), RepoError);
  }
});

test('clean rolled-back replacement requires the exact prior tx and replaces atomically', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-old'));
  repo.updateNodeMigration('line-a', 'rolled_back');
  assert.throws(() => repo.beginNodeMigration(migrationBegin('line-a', 'tx-new')), RepoError);
  assert.throws(() => repo.beginNodeMigration(migrationBegin('line-a', 'tx-new', {
    replaceRolledBackTxId: 'tx-wrong',
  })), RepoError);
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-new', {
    replaceRolledBackTxId: 'tx-old',
  }));
  assert.equal(repo.nodeMigration('line-a')?.txId, 'tx-new');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'legacy', platformVersion: '', migrationState: 'preparing', migrationError: 'none',
  });
});

test('failed clean rolled-back replacement restores the prior journal and projection', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-old'));
  repo.updateNodeMigration('line-a', 'rolled_back');
  db.exec(`CREATE TRIGGER reject_replacement BEFORE INSERT ON instance_node_migration
    WHEN NEW.tx_id = 'tx-new'
    BEGIN SELECT RAISE(ABORT, 'replacement rejected'); END;`);
  assert.throws(() => repo.beginNodeMigration(migrationBegin('line-a', 'tx-new', {
    replaceRolledBackTxId: 'tx-old',
  })), /replacement rejected/);
  assert.equal(repo.nodeMigration('line-a')?.txId, 'tx-old');
  assert.equal(repo.nodeMigration('line-a')?.phase, 'rolled_back');
  assert.equal(repo.nodeRuntime('line-a')?.migrationState, 'rolled_back');
});

test('final commit accepts only a matching clean verifying journal and projection', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  for (const instanceId of ['line-preparing', 'line-manual', 'line-mismatch']) {
    repo.create(rec({ id: instanceId, adminRoot: `/red/${instanceId}/` }), [], cred());
    repo.beginNodeMigration(migrationBegin(instanceId, `tx-${instanceId}`));
  }

  assert.throws(() => repo.commitNodeMigration('line-preparing', '0.0.1', 'admin'), RepoError);
  repo.updateNodeMigration('line-manual', 'manual_required', 'state-inconsistent');
  assert.throws(() => repo.commitNodeMigration('line-manual', '0.0.1', 'admin'), RepoError);
  repo.updateNodeMigration('line-mismatch', 'verifying');
  db.prepare(
    "UPDATE instance SET node_migration_error = 'verification' WHERE id = 'line-mismatch'",
  ).run();
  assert.throws(() => repo.commitNodeMigration('line-mismatch', '0.0.1', 'admin'), RepoError);

  assert.equal(repo.nodeMigration('line-preparing')?.phase, 'preparing');
  assert.equal(repo.nodeMigration('line-manual')?.phase, 'manual_required');
  assert.equal(repo.nodeMigration('line-mismatch')?.phase, 'verifying');
  assert.deepEqual(repo.nodeRuntime('line-preparing'), {
    mode: 'legacy', platformVersion: '', migrationState: 'preparing', migrationError: 'none',
  });
  assert.deepEqual(repo.nodeRuntime('line-manual'), {
    mode: 'legacy', platformVersion: '',
    migrationState: 'manual_required', migrationError: 'state-inconsistent',
  });
  assert.deepEqual(repo.nodeRuntime('line-mismatch'), {
    mode: 'legacy', platformVersion: '',
    migrationState: 'verifying', migrationError: 'verification',
  });
  const audits = db.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE action = 'commit-node-migration'",
  ).get() as { n: number };
  assert.equal(audits.n, 0);
});

test('interrupted migrations exclude clean terminal phases', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.create(rec({ id: 'line-b', adminRoot: '/red/line-b/' }), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-a'));
  repo.beginNodeMigration(migrationBegin('line-b', 'tx-b'));
  repo.updateNodeMigration('line-b', 'rolled_back');
  assert.deepEqual(repo.interruptedNodeMigrations().map((j) => j.instanceId), ['line-a']);
});

test('terminal checkpoint cleanup pending audit is controlled and idempotent', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-cleanup'));
  repo.updateNodeMigration('line-a', 'rolled_back');

  repo.recordCheckpointCleanupPending('line-a', 'system');
  repo.recordCheckpointCleanupPending('line-a', 'system');

  assert.deepEqual(
    db.prepare(
      "SELECT action, detail, result FROM audit WHERE action = 'checkpoint_cleanup_pending'",
    ).all(),
    [{
      action: 'checkpoint_cleanup_pending',
      detail: '{"code":"checkpoint_cleanup_pending"}',
      result: 'fail',
    }],
  );
  assert.deepEqual(
    repo.nodeMigrations().map((journal) => [journal.instanceId, journal.phase]),
    [['line-a', 'rolled_back']],
  );
});

test('exact tx phase CAS refuses a stale replacement and leaves the new journal untouched', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-old'));
  repo.updateNodeMigration('line-a', 'rolled_back');
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-new', { replaceRolledBackTxId: 'tx-old' }));

  assert.throws(
    () => repo.transitionNodeMigrationExact(
      'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
      ['preparing'], 'checkpointed',
    ),
    /所有权|CAS|变化/i,
  );
  assert.equal(repo.nodeMigration('line-a')?.txId, 'tx-new');
  repo.transitionNodeMigrationExact(
    'line-a', 'tx-new', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
    ['preparing'], 'checkpointed',
  );
  assert.equal(repo.nodeMigration('line-a')?.phase, 'checkpointed');
});

test('exact Task 8 finalizers reject stale tx ownership and preserve the replacement journal', () => {
  const scenarios = [
    {
      name: 'commit',
      prepare: (repo: InstanceRepo) => repo.transitionNodeMigrationExact(
        'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
        ['preparing'], 'verifying',
      ),
      finalize: (repo: InstanceRepo) => repo.commitNodeMigrationExact(
        'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
        'verifying', PLATFORM_NODE_PACKAGE.version, 'admin',
      ),
      phase: 'verifying',
    },
    {
      name: 'rollback',
      prepare: (repo: InstanceRepo) => repo.transitionNodeMigrationExact(
        'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
        ['preparing'], 'rolling_back', 'rollback',
      ),
      finalize: (repo: InstanceRepo) => repo.finishNodeMigrationRollbackExact(
        'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
        'rolling_back', 'rolled_back', 'admin',
      ),
      phase: 'rolling_back',
    },
    {
      name: 'manual',
      prepare: () => undefined,
      finalize: (repo: InstanceRepo) => repo.finishNodeMigrationManualExact(
        'line-a', 'tx-old', TEST_EXECUTION_OWNER, TEST_EXECUTION_NOW,
        ['preparing'], 'rollback', 'admin',
      ),
      phase: 'preparing',
    },
  ] as const;

  for (const scenario of scenarios) {
    const db = openDb(':memory:');
    const repo = new InstanceRepo(db, KEY);
    repo.create(rec(), [], cred());
    repo.beginNodeMigration(migrationBegin('line-a', 'tx-old'));
    scenario.prepare(repo);
    db.prepare(
      'UPDATE instance_node_migration SET tx_id = ? WHERE instance_id = ?',
    ).run('tx-replacement', 'line-a');

    assert.throws(() => scenario.finalize(repo), /所有权|CAS|变化/i, scenario.name);
    assert.equal(repo.nodeMigration('line-a')?.txId, 'tx-replacement', scenario.name);
    assert.equal(repo.nodeMigration('line-a')?.phase, scenario.phase, scenario.name);
    assert.equal(repo.nodeRuntime('line-a')?.migrationState, scenario.phase, scenario.name);
  }
});

test('Task 8 execution ownership claims, renews, fences peers, and clears on terminals', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  const ownerA = 'owner-repository-a-0001';
  const ownerB = 'owner-repository-b-0001';
  repo.beginNodeMigration(migrationBegin('line-a', 'tx-owned', {
    executionOwner: ownerA,
    executionLeaseExpiresAt: 2_000,
  }));
  assert.equal(repo.nodeMigration('line-a')?.executionOwner, ownerA);
  assert.equal(repo.nodeMigration('line-a')?.executionLeaseExpiresAt, 2_000);

  assert.equal(
    repo.claimNodeMigrationExecution(
      'line-a', 'tx-owned', ownerB, ['preparing'], 1_999, 1_000,
    ),
    undefined,
  );
  assert.equal(
    repo.claimNodeMigrationExecution(
      'line-a', 'tx-owned', ownerA, ['preparing'], 1_000, 2_000,
    )?.executionLeaseExpiresAt,
    3_000,
  );
  assert.equal(
    repo.renewNodeMigrationExecution(
      'line-a', 'tx-owned', ownerA, ['preparing'], 1_500, 2_000,
    ).executionLeaseExpiresAt,
    3_500,
  );
  assert.throws(
    () => repo.renewNodeMigrationExecution(
      'line-a', 'tx-owned', ownerB, ['preparing'], 1_500, 2_000,
    ),
    /所有权|租约|owner/i,
  );
  assert.equal(
    repo.claimNodeMigrationExecution(
      'line-a', 'tx-owned', ownerB, ['preparing'], 3_500, 1_000,
    )?.executionOwner,
    ownerB,
  );
  assert.throws(
    () => repo.transitionNodeMigrationExact(
      'line-a', 'tx-owned', ownerA, 3_500, ['preparing'], 'verifying',
    ),
    /所有权|租约|CAS|变化/i,
  );
  repo.transitionNodeMigrationExact(
    'line-a', 'tx-owned', ownerB, 3_500, ['preparing'], 'verifying',
  );
  repo.commitNodeMigrationExact(
    'line-a', 'tx-owned', ownerB, 3_500,
    'verifying', PLATFORM_NODE_PACKAGE.version, 'admin',
  );
  assert.equal(repo.nodeMigration('line-a')?.executionOwner, '');
  assert.equal(repo.nodeMigration('line-a')?.executionLeaseExpiresAt, 0);
  assert.doesNotMatch(JSON.stringify(repo.nodeRuntime('line-a')), /owner-repository/);
});

test('exact Task 8 rollback and manual terminals clear execution ownership', () => {
  for (const terminal of ['rolled_back', 'manual_required'] as const) {
    const repo = fresh();
    repo.create(rec(), [], cred());
    const txId = `tx-clear-${terminal}`;
    const owner = `owner-clear-${terminal}`;
    repo.beginNodeMigration(migrationBegin('line-a', txId, {
      executionOwner: owner,
      executionLeaseExpiresAt: 10_000,
    }));
    repo.transitionNodeMigrationExact(
      'line-a', txId, owner, 1_000, ['preparing'], 'rolling_back', 'rollback',
    );
    if (terminal === 'rolled_back') {
      repo.finishNodeMigrationRollbackExact(
        'line-a', txId, owner, 1_000, 'rolling_back', 'rolled_back', 'admin',
      );
    } else {
      repo.finishNodeMigrationManualExact(
        'line-a', txId, owner, 1_000, ['rolling_back'], 'rollback', 'admin',
      );
    }
    assert.equal(repo.nodeMigration('line-a')?.executionOwner, '', terminal);
    assert.equal(repo.nodeMigration('line-a')?.executionLeaseExpiresAt, 0, terminal);
  }
});
