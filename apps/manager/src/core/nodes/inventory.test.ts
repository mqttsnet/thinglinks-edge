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
