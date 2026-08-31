import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, inventoryOf } from './inventory.ts';
import type { InstalledModule } from '../flows/admin-client.ts';

const mod = (over: Partial<InstalledModule>): InstalledModule => ({
  module: 'x', version: '1.0.0', local: true, types: [], enabled: true, ...over,
});

test('镜像自带的不算现场私装', () => {
  assert.equal(classify(mod({ module: 'node-red', local: false }), new Set()), 'builtin');
});

test('平台自己拷进去的节点集单独归类', () => {
  assert.equal(
    classify(mod({ module: '@thinglinks/edge-nodes' }), new Set()),
    'platform',
  );
});

test('在批准清单里就是合规，不在就要被点出来', () => {
  const approved = new Set(['node-red-contrib-modbus']);
  assert.equal(classify(mod({ module: 'node-red-contrib-modbus' }), approved), 'approved');
  assert.equal(classify(mod({ module: 'node-red-contrib-other' }), approved), 'unapproved');
});

const target = { upstream: 'http://x', adminRoot: '/red/a/', username: 'u', password: 'p' };

test('读得到时统计出未批准的个数', async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('auth/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { module: 'node-red', version: '5.0.4', local: false, types: ['inject'], enabled: true },
      { module: 'ok-node', version: '1.0.0', local: true, types: ['a'], enabled: true },
      { module: 'bad-node', version: '2.0.0', local: true, types: ['b'], enabled: true },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const inv = await inventoryOf('line-a', target, new Set(['ok-node']), fetchImpl);
  assert.equal(inv.ok, true);
  assert.equal(inv.unapproved, 1);
  assert.deepEqual(
    inv.modules.map((m) => [m.module, m.compliance]),
    [['bad-node', 'unapproved'], ['node-red', 'builtin'], ['ok-node', 'approved']],
  );
});

test('实例连不上时回一条 ok:false，而不是让整页崩掉', async () => {
  const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
  const inv = await inventoryOf('line-b', target, new Set(), fetchImpl);
  assert.equal(inv.ok, false);
  assert.match(inv.reason, /ECONNREFUSED/);
  assert.deepEqual(inv.modules, []);
});

test('同一模块的多个节点集按模块归并，有一个停用就不算全启用', async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('auth/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { module: 'm', version: '1.0.0', local: true, types: ['a'], enabled: true },
      { module: 'm', version: '1.0.0', local: true, types: ['b'], enabled: false },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const inv = await inventoryOf('line-c', target, new Set(['m']), fetchImpl);
  assert.equal(inv.modules.length, 1);
  assert.deepEqual(inv.modules[0]!.types, ['a', 'b']);
  assert.equal(inv.modules[0]!.enabled, false);
});
