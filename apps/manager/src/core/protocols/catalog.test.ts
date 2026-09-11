import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromNodeSets, type InstalledNodeSet } from '../flows/admin-client.ts';
import { PROTOCOL_COMPONENTS, protocolStatuses } from './catalog.ts';
import { storedPackageFacts } from './store.ts';
import type { NodeStore } from '../nodes/store.ts';
import type { NodeCatalog } from '../nodes/catalog.ts';

const req = () => PROTOCOL_COMPONENTS.find((p) => p.id === 'modbus-tcp')!.requirements[0]!;
const facts = () => ({ packagePresent: true, integrityValid: true, approval: 'exact' as const });
const installed = (overrides: Partial<InstalledNodeSet> = {}) => {
  const r = req();
  return moduleFromNodeSets(r.module, [{ id: 'modbus', name: 'modbus', module: r.module,
    version: r.version, types: r.nodeTypes, enabled: true, err: '', ...overrides }]);
};

test('catalogue distinguishes available protocol adapters from serial and extension candidates', () => {
  assert.equal(PROTOCOL_COMPONENTS.filter((p) => p.status === 'available').length, 7);
  assert.equal(PROTOCOL_COMPONENTS.find((p) => p.id === 'modbus-rtu')!.status, 'blocked');
  for (const id of ['coap', 'bacnet', 'iec104']) {
    assert.equal(PROTOCOL_COMPONENTS.find((p) => p.id === id)!.status, 'extension');
  }
  assert.ok(protocolStatuses(facts).every((p) => p.ready === null));
});

test('cache and approval never substitute for exact runtime loaded types', () => {
  const status = (modules: ReturnType<typeof installed>[]) => protocolStatuses(facts, modules)
    .find((p) => p.id === 'modbus-tcp')!;
  assert.equal(status([]).ready, false);
  assert.equal(status([installed({ version: '0.0.1' })]).ready, false);
  assert.equal(status([installed({ enabled: false })]).ready, false);
  assert.equal(status([installed({ enabledKnown: false })]).ready, false);
  assert.equal(status([installed({ err: 'failed' })]).ready, false);
  assert.equal(status([installed({ err: 'failed' })]).packages[0]!.installation, 'installed');
  assert.equal(status([installed({ types: ['modbus-client'] })]).ready, false);
  assert.equal(status([installed()]).ready, true);
});

test('runtime readiness is independent of package cache or pending approval changes', () => {
  const absent = () => ({ packagePresent: false, integrityValid: false, approval: 'missing' as const });
  const p = protocolStatuses(absent, [installed()]).find((p) => p.id === 'modbus-tcp')!;
  assert.equal(p.ready, true);
  assert.equal(p.packages[0]!.packagePresent, false);
  assert.equal(p.packages[0]!.approval, 'missing');
});

test('wrong owners and duplicate node types cannot satisfy readiness', () => {
  const conflicting = installed({ module: 'other-module' });
  const p = protocolStatuses(facts, [installed(), conflicting]).find((p) => p.id === 'modbus-tcp')!;
  assert.equal(p.ready, false);
});

test('unreachable instance and absent builtin types never appear ready', () => {
  assert.ok(protocolStatuses(facts, []).every((p) => p.ready === false));
  const builtin = moduleFromNodeSets('node-red', [{id: 'tcp', name: 'tcp', module: 'node-red',
    version: '5.0.4', types: ['tcp in', 'tcp out'], enabled: true, err: ''}]);
  assert.equal(protocolStatuses(facts, [builtin]).find((p) => p.id === 'tcp')!.ready, true);
});

test('cached bytes must match the fixed integrity and approval ranges remain explicit', () => {
  const store = { tarball: () => Buffer.from('modified') } as unknown as NodeStore;
  const catalog = { get: () => ({ version: '^5.0.0' }) } as unknown as NodeCatalog;
  assert.deepEqual(storedPackageFacts(store, catalog)(req()), {
    packagePresent: true, integrityValid: false, approval: 'other',
  });
});
