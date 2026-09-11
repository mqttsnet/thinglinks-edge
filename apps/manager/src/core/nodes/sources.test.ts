import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { NpmSourceRepo, normalizeSourceUrl } from './sources.ts';
import { NodePolicyError } from './policy.ts';

const fresh = () => new NpmSourceRepo(openDb(':memory:'));

test('地址归一：去掉尾斜杠，保留子路径', () => {
  assert.equal(normalizeSourceUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org');
  assert.equal(normalizeSourceUrl(' http://nexus.corp/repo/npm/ '), 'http://nexus.corp/repo/npm');
});

test('非法地址拒掉，错误话说得清', () => {
  assert.throws(() => normalizeSourceUrl('不是地址'), /不是合法 URL/);
  assert.throws(() => normalizeSourceUrl('ftp://x/y'), /只支持 http\/https/);
  // 带查询串会拼出乱七八糟的 URL，报错难懂，不如当场挡住
  assert.throws(() => normalizeSourceUrl('https://x/y?a=1'), /不要带查询串/);
});

test('增删与启停', () => {
  const r = fresh();
  const s = r.add({ name: '官方', url: 'https://registry.npmjs.org', actor: 'alice' });
  assert.equal(s.enabled, true);
  assert.equal(s.createdBy, 'alice');
  assert.equal(r.active().length, 1);

  r.setEnabled(s.id, false);
  assert.equal(r.active().length, 0);
  assert.equal(r.list().length, 1, '停用不是删除');

  assert.equal(r.remove(s.id), true);
  assert.equal(r.remove(s.id), false);
});

test('同一个地址不重复加（归一后比较）', () => {
  const r = fresh();
  r.add({ name: 'a', url: 'https://registry.npmjs.org', actor: 'x' });
  assert.throws(() => r.add({ name: 'b', url: 'https://registry.npmjs.org/', actor: 'x' }),
    NodePolicyError);
});

test('名称留空时用地址兜底 —— 列表里不能出现无名条目', () => {
  const r = fresh();
  const s = r.add({ name: '  ', url: 'https://registry.npmjs.org', actor: 'x' });
  assert.equal(s.name, 'https://registry.npmjs.org');
});

test('seed 只在表为空时插 —— 不能覆盖运维配过的源', () => {
  const r = fresh();
  r.seed('https://registry.npmjs.org');
  assert.equal(r.list().length, 1);
  r.seed('https://other.example');          // 已有源，不该再插
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0]!.url, 'https://registry.npmjs.org');
});

test('seed 传空表示这个部署刻意不配上游（纯离线）', () => {
  const r = fresh();
  r.seed('');
  assert.deepEqual(r.list(), []);
});

test('active 保持加入顺序 —— 搜索与下载都按这个顺序依次尝试', () => {
  const r = fresh();
  r.add({ name: '内网', url: 'http://nexus.corp/npm', actor: 'x' });
  r.add({ name: '公网', url: 'https://registry.npmjs.org', actor: 'x' });
  assert.deepEqual(r.active().map((s) => s.name), ['内网', '公网']);
});
