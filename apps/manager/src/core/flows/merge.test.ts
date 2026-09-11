import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFlows } from './merge.ts';
import type { FlowNode } from './types.ts';

test('append retains existing flows and remaps node/config/subflow/group references only', () => {
  const existing = [{ id: 'old', type: 'tab', label: 'Keep me' }];
  const incoming: FlowNode[] = [
    { id: 'tab', type: 'tab' },
    { id: 'broker', type: 'mqtt-broker', name: 'broker' },
    { id: 'sub', type: 'subflow', in: [{ wires: [{ id: 'in' }] }], out: [{ wires: [{ id: 'in', port: 0 }] }], status: { wires: [{ id: 'in', port: 0 }] } },
    { id: 'in', type: 'mqtt in', z: 'sub', broker: 'broker', payload: 'broker', topic: 'broker', wires: [['link']] },
    { id: 'group', type: 'group', z: 'tab', nodes: ['link', 'use'] },
    { id: 'link', type: 'link out', z: 'tab', g: 'group', links: ['in'], scope: ['in'] },
    { id: 'use', type: 'subflow:sub', z: 'tab', g: 'group', func: 'return "in";', payload: { id: 'in', broker: 'broker' }, env: [{ name: 'ID', value: 'in', type: 'str' }] },
  ];
  const before = structuredClone(incoming);
  const merged = appendFlows(existing, incoming, (id) => `new-${id}`);
  assert.deepEqual(merged[0], existing[0]);
  assert.equal(merged.length, 8);
  const byId = new Map(merged.map((n) => [n.id, n]));
  assert.equal(byId.get('new-in')?.broker, 'new-broker');
  assert.equal(byId.get('new-in')?.payload, 'broker');
  assert.equal(byId.get('new-in')?.topic, 'broker');
  assert.deepEqual(byId.get('new-in')?.wires, [['new-link']]);
  assert.deepEqual(byId.get('new-sub')?.in, [{ wires: [{ id: 'new-in' }] }]);
  assert.deepEqual(byId.get('new-sub')?.status, { wires: [{ id: 'new-in', port: 0 }] });
  assert.deepEqual(byId.get('new-group')?.nodes, ['new-link', 'new-use']);
  assert.deepEqual(byId.get('new-link')?.links, ['new-in']);
  assert.equal(byId.get('new-use')?.type, 'subflow:new-sub');
  assert.deepEqual(byId.get('new-use')?.payload, { id: 'in', broker: 'broker' });
  assert.deepEqual(byId.get('new-use')?.env, [{ name: 'ID', value: 'in', type: 'str' }]);
  assert.deepEqual(incoming, before);
});

test('append rejects dangling structural links and unsupported config references without mutating old flows', () => {
  assert.throws(() => appendFlows([], [{ id: 'a', type: 'debug', z: 'missing' }]), /引用/);
  assert.throws(() => appendFlows([], [{ id: 'a', type: 'subflow:missing' }]), /引用/);
  assert.throws(() => appendFlows([{ id: 'same', type: 'tab' }], [{ id: 'a', type: 'tab' }], () => 'same'), /id/);
  assert.throws(() => appendFlows([], [{ id: 'c', type: 'custom-config' }, { id: 'a', type: 'custom', customConnection: 'c' }]), /customConnection/);
});

test('append validates duplicate ids and accepts references to existing configs', () => {
  assert.throws(() => appendFlows([], [{ id: 'a', type: 'tab' }, { id: 'a', type: 'tab' }]), /重复/);
  const merged = appendFlows([{ id: 'b', type: 'mqtt-broker' }], [{ id: 'a', type: 'mqtt in', broker: 'b' }], () => 'new');
  assert.equal(merged[1]?.broker, 'b');
});

test('unknown node types cannot resolve inherited properties as reference schemas', () => {
  const merged = appendFlows([], [{ id: 't', type: 'tab' }, { id: 'a', type: '__proto__', z: 't' }], (id) => `new-${id}`);
  assert.equal(merged[1]?.z, 'new-t');
  assert.equal(merged[1]?.type, '__proto__');
});

test('tier0 read and write clone only their known connection references into the copied graph', () => {
  const current: FlowNode[] = [{ id: 'connection', type: 'tier0-opcua-connection', endpoint: 'opc.tcp://existing:4840' }];
  const incoming: FlowNode[] = [
    { id: 'tab', type: 'tab' },
    { id: 'connection', type: 'tier0-opcua-connection', endpoint: 'opc.tcp://device:4840', privateKey: '/data/client.key' },
    { id: 'read', type: 'tier0-opcua-read', z: 'tab', connection: 'connection', nodeId: 'ns=1;s=Temperature', pointList: '[{"nodeId":"ns=1;s=Temperature"}]', wires: [['write']] },
    { id: 'write', type: 'tier0-opcua-write', z: 'tab', connection: 'connection', payload: { nodeId: 'connection' }, wires: [[]] },
  ];
  const before = structuredClone(incoming);
  const merged = appendFlows(current, incoming, id => `new-${id}`);
  assert.deepEqual(merged[0], current[0]);
  assert.equal(merged.find(node => node.id === 'new-read')!.connection, 'new-connection');
  assert.equal(merged.find(node => node.id === 'new-write')!.connection, 'new-connection');
  assert.equal(merged.find(node => node.id === 'new-connection')!.endpoint, 'opc.tcp://device:4840');
  assert.equal(merged.find(node => node.id === 'new-read')!.nodeId, 'ns=1;s=Temperature');
  assert.deepEqual(merged.find(node => node.id === 'new-write')!.payload, { nodeId: 'connection' });
  assert.deepEqual(incoming, before);
  assert.throws(() => appendFlows([], [{ id: 'c', type: 'tier0-opcua-connection' }, { id: 'n', type: 'tier0-opcua-unknown', connection: 'c' }]), /尚不支持安全追加/);
  assert.throws(() => appendFlows([], [{ id: 'n', type: 'tier0-opcua-read', connection: 'missing' }]), /无法解析的节点引用/);
});
