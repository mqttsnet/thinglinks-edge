import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, recordAudit } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo, RepoError, type InstanceRecord, type PortRecord } from './repo.ts';
import { PLATFORM_NODE_PACKAGE } from '../nodes/platform-contract.ts';

const KEY = deriveKey('test-master', 'salt');
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
  repo.beginNodeMigration({
    instanceId: 'line-a', txId: 'tx-sync', operationKind: 'migration',
    phase: 'preparing', originalRunning: true, stagedBefore: false,
    modeBefore: 'legacy', imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-sync',
    snapshotJson: JSON.stringify({ settingsSha256: 'a'.repeat(64) }),
    actor: 'admin',
  });
  repo.updateNodeMigration('line-a', 'verifying', 'probe failed');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'legacy',
    platformVersion: '',
    migrationState: 'verifying',
    migrationError: 'probe failed',
  });
  assert.equal(repo.nodeMigration('line-a')?.phase, 'verifying');
  repo.commitNodeMigration('line-a', '0.0.1', 'admin');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'npm', platformVersion: '0.0.1',
    migrationState: 'committed', migrationError: '',
  });
  assert.equal(repo.nodeMigration('line-a')?.phase, 'committed');
  const audit = db.prepare(
    "SELECT actor, target FROM audit WHERE action = 'commit-node-migration'",
  ).get() as { actor: string; target: string };
  assert.deepEqual(audit, { actor: 'admin', target: 'line-a' });
});

test('journal round-trips recovery facts without secrets', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.beginNodeMigration({
    instanceId: 'line-a', txId: 'tx-01', operationKind: 'migration',
    phase: 'preparing',
    originalRunning: false, stagedBefore: true, modeBefore: 'legacy',
    imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-01',
    snapshotJson: JSON.stringify({
      settingsSha256: 'a'.repeat(64), flowsSha256: 'b'.repeat(64),
      credentialsSha256: 'c'.repeat(64), packageSha256: 'd'.repeat(64),
      lockSha256: 'e'.repeat(64),
    }),
    actor: 'admin',
  });
  const journal = repo.nodeMigration('line-a');
  assert.equal(journal?.originalRunning, false);
  assert.equal(journal?.stagedBefore, true);
  assert.doesNotMatch(JSON.stringify(journal), /token|password|secret|npmrc/i);
});

test('startup projection mismatch becomes manual_required', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration({
    instanceId: 'line-a', txId: 'tx-recover', operationKind: 'migration',
    phase: 'preparing', originalRunning: true, stagedBefore: false,
    modeBefore: 'legacy', imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-recover',
    snapshotJson: '{}', actor: 'admin',
  });
  db.prepare(
    "UPDATE instance SET node_migration_state = 'verifying', node_migration_error = 'corrupt' WHERE id = 'line-a'",
  ).run();

  const reopened = new InstanceRepo(db, KEY);
  assert.equal(reopened.nodeRuntime('line-a')?.migrationState, 'manual_required');
  assert.equal(reopened.nodeMigration('line-a')?.phase, 'manual_required');
  assert.equal(
    reopened.nodeRuntime('line-a')?.migrationError,
    reopened.nodeMigration('line-a')?.error,
  );
});

test('phase update rolls back journal when projection update fails', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration({
    instanceId: 'line-a', txId: 'tx-atomic', operationKind: 'migration',
    phase: 'preparing', originalRunning: true, stagedBefore: false,
    modeBefore: 'legacy', imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-atomic', snapshotJson: '{}', actor: 'admin',
  });
  db.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE ON instance
    WHEN NEW.node_migration_state = 'verifying'
    BEGIN SELECT RAISE(ABORT, 'projection rejected'); END;`);
  assert.throws(() => repo.updateNodeMigration('line-a', 'verifying', 'failed'), /projection rejected/);
  assert.equal(repo.nodeMigration('line-a')?.phase, 'preparing');
  assert.equal(repo.nodeRuntime('line-a')?.migrationState, 'preparing');
});

test('final commit rolls back journal and projection when audit fails', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  repo.beginNodeMigration({
    instanceId: 'line-a', txId: 'tx-commit', operationKind: 'migration',
    phase: 'verifying', originalRunning: true, stagedBefore: false,
    modeBefore: 'legacy', imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-commit', snapshotJson: '{}', actor: 'admin',
  });
  db.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON audit
    WHEN NEW.action = 'commit-node-migration'
    BEGIN SELECT RAISE(ABORT, 'audit rejected'); END;`);
  assert.throws(() => repo.commitNodeMigration('line-a', '0.0.1', 'admin'), /audit rejected/);
  assert.equal(repo.nodeMigration('line-a')?.phase, 'verifying');
  assert.deepEqual(repo.nodeRuntime('line-a'), {
    mode: 'legacy', platformVersion: '', migrationState: 'verifying', migrationError: '',
  });
});

test('journal validates enums ids paths snapshots and redacts bounded errors before writes', () => {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, KEY);
  repo.create(rec(), [], cred());
  const valid = {
    instanceId: 'line-a', txId: 'tx-valid', operationKind: 'migration' as const,
    phase: 'preparing' as const, originalRunning: true, stagedBefore: false,
    modeBefore: 'legacy' as const, imageIdBefore: 'sha256:image-a',
    targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: '.thinglinks-migration/line-a/tx-valid', snapshotJson: '{}', actor: 'admin',
  };
  assert.throws(() => repo.beginNodeMigration({ ...valid, txId: '../escape' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '/tmp/checkpoint' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '../checkpoint' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, checkpointDir: '' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, operationKind: 'invalid' as 'migration' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, phase: 'idle' as 'preparing' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({ ...valid, modeBefore: 'invalid' as 'legacy' }), RepoError);
  assert.throws(() => repo.beginNodeMigration({
    ...valid,
    snapshotJson: JSON.stringify({ password: 'raw-password' }),
  }), RepoError);
  assert.equal(repo.nodeMigration('line-a'), undefined);

  repo.beginNodeMigration({
    ...valid, operationKind: 'bootstrap', checkpointDir: '', txId: 'tx-bootstrap',
    originalRunning: false,
  });
  assert.throws(() => repo.updateNodeMigration('line-a', 'committed'), RepoError);
  repo.updateNodeMigration(
    'line-a', 'manual_required', `password=super-secret-value ${'x'.repeat(3000)}`,
  );
  const error = repo.nodeMigration('line-a')?.error ?? '';
  assert.ok(error.length <= 2000);
  assert.doesNotMatch(error, /super-secret-value/);
});

test('interrupted migrations exclude clean terminal phases', () => {
  const repo = fresh();
  repo.create(rec(), [], cred());
  repo.create(rec({ id: 'line-b', adminRoot: '/red/line-b/' }), [], cred());
  const begin = (instanceId: string, txId: string) => repo.beginNodeMigration({
    instanceId, txId, operationKind: 'migration', phase: 'preparing',
    originalRunning: true, stagedBefore: false, modeBefore: 'legacy',
    imageIdBefore: 'sha256:image-a', targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
    checkpointDir: `.thinglinks-migration/${instanceId}/${txId}`, snapshotJson: '{}', actor: 'admin',
  });
  begin('line-a', 'tx-a');
  begin('line-b', 'tx-b');
  repo.updateNodeMigration('line-b', 'rolled_back');
  assert.deepEqual(repo.interruptedNodeMigrations().map((j) => j.instanceId), ['line-a']);
});
