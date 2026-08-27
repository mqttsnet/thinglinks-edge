import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { FieldRegistry, RegistryError } from './registry.ts';

/** 每个用例一个内存库，并预置一台实例满足外键 */
function fresh() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO instance (id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret)
     VALUES ('line-a', '一号线', 'tag', 512, 0.5, '/red/line-a/', 'x')`,
  ).run();
  return { db, reg: new FieldRegistry(db) };
}

test('注册设备是幂等的 —— flow 重启会重放注册', () => {
  const { reg } = fresh();
  const d = { nodeId: 'plc-1', name: '1#注塑机', protocol: 'modbus-tcp', address: '192.168.1.10:502' };
  reg.upsertDevice('line-a', d);
  reg.upsertDevice('line-a', { ...d, name: '1#注塑机（改名）' });
  const list = reg.devices('line-a');
  assert.equal(list.length, 1, '重复注册不应产生第二条');
  assert.equal(list[0]!.name, '1#注塑机（改名）', '应更新而不是忽略');
  assert.equal(list[0]!.protocol, 'modbus-tcp');
});

test('点位值按原始类型往返，不会把 1 和 "1" 弄混', () => {
  const { reg } = fresh();
  reg.upsertDevice('line-a', { nodeId: 'plc-1', name: 'x' });
  reg.recordValues('line-a', [
    { nodeId: 'plc-1', tagId: 'temp', value: 21.5 },
    { nodeId: 'plc-1', tagId: 'name', value: '1' },
    { nodeId: 'plc-1', tagId: 'run', value: true },
    { nodeId: 'plc-1', tagId: 'obj', value: { a: [1, 2] } },
    { nodeId: 'plc-1', tagId: 'nil', value: null },
  ]);
  const byId = Object.fromEntries(reg.tags('line-a').map((t) => [t.tagId, t.lastValue]));
  assert.equal(byId['temp'], 21.5);
  assert.equal(byId['name'], '1');
  assert.equal(byId['run'], true);
  assert.deepEqual(byId['obj'], { a: [1, 2] });
  assert.equal(byId['nil'], null);
});

test('未定义过的点位自动补定义，值不丢', () => {
  const { reg } = fresh();
  reg.upsertDevice('line-a', { nodeId: 'plc-1', name: 'x' });
  // 现场常见先有值后补元数据
  reg.recordValues('line-a', [{ nodeId: 'plc-1', tagId: 'p1', value: 7 }]);
  assert.equal(reg.tags('line-a').length, 1);
  reg.upsertTag('line-a', { nodeId: 'plc-1', tagId: 'p1', name: '压力', unit: 'MPa' });
  const t = reg.tags('line-a')[0]!;
  assert.equal(t.name, '压力');
  assert.equal(t.unit, 'MPa');
  assert.equal(t.lastValue, 7, '补定义不能把已有的值冲掉');
});

test('有值上来即视为设备在线', () => {
  const { reg } = fresh();
  reg.upsertDevice('line-a', { nodeId: 'plc-1', name: 'x' });
  assert.equal(reg.devices('line-a')[0]!.online, false, '刚注册时未知在线状态');
  reg.recordValues('line-a', [{ nodeId: 'plc-1', tagId: 'p1', value: 1 }]);
  const d = reg.devices('line-a')[0]!;
  assert.equal(d.online, true);
  assert.ok(d.lastSeen, 'lastSeen 应被填上');
});

test('质量码缺省为 good，可显式覆盖', () => {
  const { reg } = fresh();
  reg.recordValues('line-a', [
    { nodeId: 'p', tagId: 'a', value: 1 },
    { nodeId: 'p', tagId: 'b', value: 2, quality: 'bad' },
  ]);
  const q = Object.fromEntries(reg.tags('line-a').map((t) => [t.tagId, t.quality]));
  assert.equal(q['a'], 'good');
  assert.equal(q['b'], 'bad');
});

test('删除实例时台账随之清空（外键级联）', () => {
  const { db, reg } = fresh();
  reg.upsertDevice('line-a', { nodeId: 'plc-1', name: 'x' });
  reg.recordValues('line-a', [{ nodeId: 'plc-1', tagId: 'p1', value: 1 }]);
  db.prepare("DELETE FROM instance WHERE id = 'line-a'").run();
  assert.deepEqual(reg.devices('line-a'), []);
  assert.deepEqual(reg.tags('line-a'), []);
});

test('空 id 与超长 id 被拒', () => {
  const { reg } = fresh();
  assert.throws(() => reg.upsertDevice('line-a', { nodeId: '', name: 'x' }), RegistryError);
  assert.throws(() => reg.upsertDevice('line-a', { nodeId: '   ', name: 'x' }), RegistryError);
  assert.throws(() => reg.upsertTag('line-a', { nodeId: 'p', tagId: 'x'.repeat(129) }), RegistryError);
  assert.throws(() => reg.recordValues('line-a', [{ nodeId: 'p', tagId: '', value: 1 }]), RegistryError);
});

test('一批值里有一条非法时整批回滚', () => {
  const { reg } = fresh();
  assert.throws(() => reg.recordValues('line-a', [
    { nodeId: 'p', tagId: 'ok', value: 1 },
    { nodeId: 'p', tagId: '', value: 2 },
  ]), RegistryError);
  assert.deepEqual(reg.tags('line-a'), [], '前一条也不该留下');
});

test('汇总只涵盖已纳管部分', () => {
  const { reg } = fresh();
  reg.upsertDevice('line-a', { nodeId: 'p1', name: 'a' });
  reg.upsertDevice('line-a', { nodeId: 'p2', name: 'b' });
  reg.recordValues('line-a', [
    { nodeId: 'p1', tagId: 't1', value: 1 },
    { nodeId: 'p1', tagId: 't2', value: 2 },
  ]);
  assert.deepEqual(reg.summary('line-a'), { devices: 2, online: 1, tags: 2 });
});
