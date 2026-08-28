import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, recordAudit } from './db.ts';
import { deriveKey } from './crypto.ts';
import { InstanceRepo, RepoError, type InstanceRecord, type PortRecord } from './instance-repo.ts';

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
