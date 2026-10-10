import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANAGED_FLOW_RESPONSE_MAX_BYTES } from '../../flows/admin-client.ts';
import { buildModbusDiagnosticFlow } from './modbus-flow.ts';
import { assertDiagnosticGraphCapacity, diagnosticFlowReadReservation } from './flow-capacity.ts';

test('reserved bytes include the flattened temporary graph even with maximum assigned tab IDs', () => {
  const { flow } = buildModbusDiagnosticFlow({ taskId: 'capacity-task', readerId: 'capacity-reader', host: '192.0.2.1', port: 502, unitId: 1, registerType: 'HoldingRegister', address: 0, quantity: 2, clientTimeout: 100, reconnectTimeout: 100, expiresAt: Date.now() + 10000 });
  const assignedId = 'a'.repeat(128);
  const { nodes, configs = [], ...tab } = flow;
  const deployed = [{ ...tab, id: assignedId, type: 'tab' }, ...nodes.map(node => ({ ...node, z: assignedId })), ...configs.map(node => ({ ...node, z: assignedId }))];
  const reserved = diagnosticFlowReadReservation(flow);
  assert.ok(reserved > Buffer.byteLength(JSON.stringify(deployed, null, 4), 'utf8') + 8192);
  assert.ok(reserved < MANAGED_FLOW_RESPONSE_MAX_BYTES);
});

test('graph capacity counts UTF-8 bytes rather than character count', () => {
  const existing = [{ id: 'business', type: 'function', func: '中'.repeat(Math.ceil(MANAGED_FLOW_RESPONSE_MAX_BYTES / 3)) }];
  assert.ok(JSON.stringify(existing).length < MANAGED_FLOW_RESPONSE_MAX_BYTES);
  assert.throws(() => assertDiagnosticGraphCapacity(existing, 16384));
});
