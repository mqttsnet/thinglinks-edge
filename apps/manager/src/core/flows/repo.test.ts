import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { TemplateRepo } from './repo.ts';
import { TemplateError, type FlowNode } from './types.ts';

const flows = (): FlowNode[] => [
  { id: 'tab1', type: 'tab', label: '一号产线' },
  { id: 'in1', type: 'mqtt in', z: 'tab1', name: '温度', topic: 'plant/temp' },
  { id: 'fn1', type: 'function', z: 'tab1', name: '换算', func: 'return msg;' },
  { id: 'out1', type: 'debug', z: 'tab1', name: '输出' },
];
const fresh = () => new TemplateRepo(openDb(':memory:'));

test('保存后可读回，体检结果一并落库', () => {
  const repo = fresh();
  const t = repo.save({ name: '产线基线', description: '标准采集', content: flows(), source: 'line-a' }, 'admin');
  assert.equal(t.name, '产线基线');
  assert.equal(t.nodeCount, 4);
  assert.equal(t.tabCount, 1);
  assert.deepEqual(t.nodeTypes, ['debug', 'function', 'mqtt in', 'tab']);
  assert.equal(t.source, 'line-a');
  assert.equal(t.createdBy, 'admin');
  assert.deepEqual(t.warnings, []);
});

test('内联凭据告警随模板一起存下来，分发前就能看到', () => {
  const repo = fresh();
  const t = repo.save({
    name: '带密钥的',
    content: [{ id: 'fn', type: 'function', name: '上云', func: "const token = 'abcdefghijklmn';" }],
  }, 'admin');
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0]!, /上云/);
});

test('列表不带内容 —— 一个模板可能几百 KB', () => {
  const repo = fresh();
  repo.save({ name: 'a', content: flows() }, 'admin');
  const list = repo.list();
  assert.equal(list.length, 1);
  assert.ok(!('flows' in list[0]!), '列表项不该带 flows');
  assert.equal(list[0]!.nodeCount, 4, '但摘要信息要有，否则列表没法用');
});

test('取完整模板时内容能原样还原', () => {
  const repo = fresh();
  const saved = repo.save({ name: 'a', content: flows() }, 'admin');
  const full = repo.getWithContent(saved.id);
  assert.ok(full);
  assert.deepEqual(full.flows, flows());
});

test('名称为空或过长要拒绝', () => {
  const repo = fresh();
  assert.throws(() => repo.save({ name: '  ', content: flows() }, 'a'), /名称不能为空/);
  assert.throws(() => repo.save({ name: 'x'.repeat(65), content: flows() }, 'a'), /名称过长/);
});

test('内容非法时不落库', () => {
  const repo = fresh();
  assert.throws(() => repo.save({ name: 'bad', content: '{}' }, 'a'), TemplateError);
  assert.equal(repo.list().length, 0, '失败的保存不该留下记录');
});

test('删除与改名', () => {
  const repo = fresh();
  const t = repo.save({ name: '旧名', content: flows() }, 'admin');
  const renamed = repo.rename(t.id, '新名', '新说明');
  assert.equal(renamed?.name, '新名');
  assert.equal(renamed?.description, '新说明');

  assert.equal(repo.remove(t.id), true);
  assert.equal(repo.remove(t.id), false, '删不存在的应回 false 而不是抛错');
  assert.equal(repo.get(t.id), undefined);
});

test('不存在的模板读回 undefined', () => {
  const repo = fresh();
  assert.equal(repo.get('no-such-id'), undefined);
  assert.equal(repo.getWithContent('no-such-id'), undefined);
});
