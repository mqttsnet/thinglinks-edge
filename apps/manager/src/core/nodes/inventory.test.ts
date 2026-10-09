import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateNodeSets,
  assertHealthyPlatformModule,
  classify,
  inventoryOf,
} from './inventory.ts';
import type { InstalledModule, InstalledNodeSet } from '../flows/admin-client.ts';

const mod = (over: Partial<InstalledModule>): InstalledModule => ({
  module: 'x', version: '1.0.0', local: true, types: [], enabled: true,
  observedVersions: ['1.0.0'], errors: [], nodeSets: [], observedFiles: [],
  source: 'npm', health: 'healthy', ...over,
});

const nodeSet = (over: Partial<InstalledNodeSet>): InstalledNodeSet => ({
  id: 'x/node', name: 'node', module: 'x', version: '1.0.0', types: ['x-node'],
  enabled: true, err: '', ...over,
});

test('镜像自带的不算现场私装', () => {
  assert.equal(classify(mod({ module: 'node-red', local: false }), new Set()), 'builtin');
});

test('only the exact published Edge package is platform owned', () => {
  assert.equal(
    classify(mod({
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1',
      observedVersions: ['0.0.1'], types: ['tl-device', 'tl-tag', 'tl-uplink'],
      nodeSets: [nodeSet({
        module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1',
        types: ['tl-device'],
      })],
    }), new Set()),
    'platform',
  );
  assert.equal(classify(mod({ module: '@mqttsnet/another-product' }), new Set()), 'unapproved');
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

test('raw platform types are not mislabeled as builtin', () => {
  const inventory = aggregateNodeSets([nodeSet({
    id: 'tl-device', name: 'tl-device', module: 'node-red', version: '5.0.4',
    types: ['tl-device'],
  })]);
  assert.equal(inventory.modules[0]?.source, 'raw');
  assert.equal(classify(inventory.modules[0]!, new Set()), 'platform');
});

test('builtin node-red types outside the target set stay builtin', () => {
  const inventory = aggregateNodeSets([nodeSet({
    id: 'inject', name: 'inject', module: 'node-red', version: '5.0.4', types: ['inject'],
    local: false,
  })]);
  assert.equal(inventory.modules[0]?.source, 'builtin');
  assert.equal(classify(inventory.modules[0]!, new Set()), 'builtin');
});

test('duplicate type ownership records every owner in deterministic order', () => {
  const inventory = aggregateNodeSets([
    nodeSet({ id: 'tl-device', module: 'node-red', version: '5.0.4', types: ['tl-device'] }),
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-device',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-device'],
    }),
  ]);
  assert.equal(inventory.health, 'conflict');
  assert.deepEqual(inventory.conflicts, [{
    type: 'tl-device', owners: ['@mqttsnet/thinglinks-edge-nodes', 'node-red'],
  }]);
});

test('module load errors take precedence over conflicts for global health', () => {
  const inventory = aggregateNodeSets([
    nodeSet({ id: 'raw', module: 'node-red', types: ['tl-device'], err: 'load failed' }),
    nodeSet({
      id: 'npm', module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1',
      types: ['tl-device'],
    }),
  ]);
  assert.equal(inventory.modules.find((m) => m.module === 'node-red')?.health, 'failed');
  assert.equal(inventory.health, 'failed');
  assert.deepEqual(inventory.conflicts, [{
    type: 'tl-device', owners: ['@mqttsnet/thinglinks-edge-nodes', 'node-red'],
  }]);
});

test('mixed node-set versions remain visible, fail health, and cannot be platform owned', () => {
  const installed = aggregateNodeSets([
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-device',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-device'],
    }),
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-tag',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.2', types: ['tl-tag'],
    }),
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-uplink',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-uplink'],
    }),
  ]).modules[0]!;

  assert.deepEqual(installed.observedVersions, ['0.0.1', '0.0.2']);
  assert.equal(installed.version, '');
  assert.equal(installed.health, 'failed');
  assert.equal(classify(installed, new Set()), 'unapproved');
  assert.throws(() => assertHealthyPlatformModule(installed), /version|版本/i);
});

test('healthy published platform module has exactly the three enabled error-free types', () => {
  const installed = aggregateNodeSets([
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-device',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-device'],
    }),
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-tag',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-tag'],
    }),
    nodeSet({
      id: '@mqttsnet/thinglinks-edge-nodes/tl-uplink',
      module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-uplink'],
    }),
  ]).modules[0]!;
  assert.doesNotThrow(() => assertHealthyPlatformModule(installed));
});

test('healthy published platform assertion rejects extra, duplicate, disabled, and failed sets', () => {
  const healthy = aggregateNodeSets([
    nodeSet({ module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-device'] }),
    nodeSet({ id: 'tag', module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-tag'] }),
    nodeSet({ id: 'uplink', module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-uplink'] }),
  ]).modules[0]!;

  assert.throws(() => assertHealthyPlatformModule({ ...healthy, version: '0.0.2' }), /版本/);
  assert.throws(() => assertHealthyPlatformModule({
    ...healthy, nodeSets: [...healthy.nodeSets, nodeSet({
      id: 'extra', module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1', types: ['tl-extra'],
    })], types: [...healthy.types, 'tl-extra'],
  }), /three|extra/i);
  assert.throws(() => assertHealthyPlatformModule({
    ...healthy, nodeSets: [
      healthy.nodeSets[0]!,
      { ...healthy.nodeSets[1]!, types: ['tl-device'] },
      healthy.nodeSets[2]!,
    ], types: ['tl-device', 'tl-uplink'],
  }), /duplicate/i);
  assert.throws(() => assertHealthyPlatformModule({
    ...healthy, nodeSets: [{ ...healthy.nodeSets[0]!, enabled: false }, ...healthy.nodeSets.slice(1)],
  }), /enabled/i);
  assert.throws(() => assertHealthyPlatformModule({
    ...healthy, nodeSets: [{ ...healthy.nodeSets[0]!, err: 'boom' }, ...healthy.nodeSets.slice(1)],
  }), /error/i);
});

test('inventory shares one deadline across authentication and a slow response body', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response('{"access_token":"t"}');
    }
    return new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    }));
  }) as typeof fetch;
  const begin = performance.now();
  const result = await inventoryOf('slow', target, new Set(), fetchImpl, { timeoutMs: 40 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /超时/);
  assert.ok(performance.now() - begin < 250);
  assert.equal(calls, 2);
});

test('inventory deadline does not start an anonymous retry after authentication expires', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return await new Promise(() => {}); }) as typeof fetch;
  const result = await inventoryOf('slow', target, new Set(), fetchImpl, { timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /超时/);
  assert.equal(calls, 1);
});

test('inventory batch skips stopped/missing instances and limits running probes to four', async () => {
  const { inventoryBatch } = await import('./inventory.ts');
  const ids = ['stopped', 'missing', ...Array.from({ length: 9 }, (_, n) => `running-${n}`)];
  let snapshots = 0;
  let active = 0;
  let maxActive = 0;
  const probed: string[] = [];
  const result = await inventoryBatch(ids, {
    list: async () => {
      snapshots++;
      return ids.map(id => ({ id, state: id.startsWith('running') ? 'running' : id === 'missing' ? 'missing' : 'exited', running: id.startsWith('running') }));
    },
    read: async (id) => {
      probed.push(id);
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { instanceId: id, ok: true, reason: '', modules: [], unapproved: 0 };
    },
  });
  assert.equal(snapshots, 1);
  assert.equal(maxActive, 4);
  assert.equal(probed.length, 9);
  assert.deepEqual(result.map(item => item.instanceId), ids);
  assert.match(result[0]!.reason, /未运行/);
  assert.match(result[1]!.reason, /不存在/);
});

test('inventory batch returns unknown for a failed or timed-out state snapshot without probing', async () => {
  const { inventoryBatch } = await import('./inventory.ts');
  let probes = 0;
  for (const list of [async () => { throw new Error('private Docker failure'); }, async () => await new Promise<never>(() => {})]) {
    const result = await inventoryBatch(['a'], { list, read: async () => { probes++; throw new Error('unexpected'); } }, { stateTimeoutMs: 20, timeoutMs: 60 });
    assert.equal(result[0]?.ok, false);
    assert.match(result[0]!.reason, /无法确认实例运行状态/);
    assert.doesNotMatch(result[0]!.reason, /private/);
  }
  assert.equal(probes, 0);
});

test('inventory batch has one overall deadline and does not probe queued instances after expiry', async () => {
  const { inventoryBatch } = await import('./inventory.ts');
  const ids = Array.from({ length: 12 }, (_, n) => String(n));
  let probes = 0;
  const begin = performance.now();
  const result = await inventoryBatch(ids, {
    list: async () => ids.map(id => ({ id, running: true, state: 'running' })),
    read: async () => { probes++; return await new Promise<never>(() => {}); },
  }, { timeoutMs: 25 });
  assert.equal(probes, 4);
  assert.equal(result.length, 12);
  assert.ok(result.every(item => !item.ok && /超时/.test(item.reason)));
  assert.ok(performance.now() - begin < 250);
});

test('inventory reports an unrecognized runtime state as unknown rather than stopped', async () => {
  const { inventoryBatch } = await import('./inventory.ts');
  const result = await inventoryBatch(['a'], {
    list: async () => [{ id: 'a', state: 'unknown', running: false }],
    read: async () => { throw new Error('must not probe unknown'); },
  });
  assert.match(result[0]!.reason, /无法确认实例运行状态/);
  assert.doesNotMatch(result[0]!.reason, /未运行/);
});
