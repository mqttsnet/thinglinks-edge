import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { NodeCatalog } from './catalog.ts';
import { NodePolicyError } from './policy.ts';
import { PLATFORM_NODE_PACKAGE } from './platform-contract.ts';
import { ensurePlatformApproval } from './platform-package.ts';

const fresh = () => new NodeCatalog(openDb(':memory:'));

test('批准一条，读得回来并带审批痕迹', () => {
  const c = fresh();
  const e = c.approve({ module: 'node-red-contrib-modbus', version: '~5.7.0', note: '产线用', actor: 'alice' });
  assert.equal(e.module, 'node-red-contrib-modbus');
  assert.equal(e.version, '~5.7.0');
  assert.equal(e.approvedBy, 'alice');
  assert.ok(e.approvedAt);
  assert.deepEqual(c.get('node-red-contrib-modbus'), e);
});

test('不限版本存成空串，读出来是 undefined —— policy 据此决定要不要拼 @range', () => {
  const c = fresh();
  const e = c.approve({ module: 'a-node', actor: 'bob' });
  assert.equal(e.version, undefined);
  assert.deepEqual(c.approved(), [{ module: 'a-node', version: undefined }]);
});

test('重复批准同一个包是更新而不是报错', () => {
  const c = fresh();
  c.approve({ module: 'a-node', version: '^1.0.0', actor: 'alice' });
  c.approve({ module: 'a-node', version: '^2.0.0', note: '升级', actor: 'bob' });
  assert.equal(c.list().length, 1);
  const e = c.get('a-node')!;
  assert.equal(e.version, '^2.0.0');
  // 审批人跟着变 —— 是谁放行了新版本，这件事必须能查到
  assert.equal(e.approvedBy, 'bob');
});

test('非法包名与非法版本在入库前就被拒', () => {
  const c = fresh();
  assert.throws(() => c.approve({ module: 'node-red-*', actor: 'a' }), NodePolicyError);
  assert.throws(() => c.approve({ module: 'a', version: "1'; DROP", actor: 'a' }), NodePolicyError);
  assert.throws(() => c.approve({ module: 'a', actor: '' }), NodePolicyError);
  assert.equal(c.list().length, 0);
});

test('撤销', () => {
  const c = fresh();
  c.approve({ module: 'a-node', actor: 'a' });
  assert.equal(c.revoke('a-node'), true);
  assert.equal(c.revoke('a-node'), false);
  assert.deepEqual(c.list(), []);
});

test('通用目录接口不能更新或撤销平台基线批准', () => {
  const c = fresh();
  const baseline = ensurePlatformApproval(c, 'system');
  assert.throws(() => c.approve({
    module: PLATFORM_NODE_PACKAGE.name,
    version: '^0.0.1',
    note: 'changed',
    actor: 'operator',
  }), NodePolicyError);
  assert.throws(() => c.revoke(PLATFORM_NODE_PACKAGE.name), NodePolicyError);
  assert.deepEqual(c.get(PLATFORM_NODE_PACKAGE.name), baseline);
});

test('非平台目录条目仍可更新和撤销', () => {
  const c = fresh();
  c.approve({ module: 'ordinary-node', version: '1.0.0', actor: 'a' });
  c.approve({ module: 'ordinary-node', version: '2.0.0', actor: 'b' });
  assert.equal(c.get('ordinary-node')?.version, '2.0.0');
  assert.equal(c.revoke('ordinary-node'), true);
});

test('备注超长截断，不让一条记录撑爆列表', () => {
  const c = fresh();
  const e = c.approve({ module: 'a-node', note: 'x'.repeat(1000), actor: 'a' });
  assert.equal(e.note.length, 500);
});

test('names() 给 policy 与台账共用同一份判定依据', () => {
  const c = fresh();
  c.approve({ module: 'b-node', actor: 'a' });
  c.approve({ module: 'a-node', actor: 'a' });
  assert.deepEqual([...c.names()].sort(), ['a-node', 'b-node']);
  // 列表按包名排序，界面不必再排一次
  assert.deepEqual(c.list().map((e) => e.module), ['a-node', 'b-node']);
});
