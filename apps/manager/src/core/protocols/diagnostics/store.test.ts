import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db.ts';
import { ProtocolDiagnosticStore } from './store.ts';
const connection = { host: '192.0.2.1', port: 502, unitId: 1, registerType: 'HoldingRegister' as const, address: 0, quantity: 2, clientTimeout: 2000, reconnectTimeout: 5000 };
test('admission is persistent, bounded and excludes cleanup failures from reuse', () => {
  const db = openDb(':memory:');
  const store = new ProtocolDiagnosticStore(db, { maxOutstanding: 1 });
  store.create({ id: 'a', instanceId: 'line-a', readerId: 'reader-a', generation: 'gen', connection, deadline: 10000, fingerprint: 'fingerprint', nodeIds: ['reader-a'] });
  assert.throws(() => store.create({ id: 'b', instanceId: 'line-b', readerId: 'reader-b', generation: 'gen', connection, deadline: 10000, fingerprint: 'f', nodeIds: [] }));
  store.update('a', { state: 'cleanup-required', cleanup: 'failed' });
  assert.equal(new ProtocolDiagnosticStore(db).unfinished().length, 1);
  assert.throws(() => store.create({ id: 'b', instanceId: 'line-a', readerId: 'r', generation: 'g', connection, deadline: 10000, fingerprint: 'f', nodeIds: [] }));
  store.update('a', { state: 'failed', cleanup: 'done' });
  store.create({ id: 'b', instanceId: 'line-a', readerId: 'r', generation: 'g', connection, deadline: 10000, fingerprint: 'f', nodeIds: [] });
  assert.equal(store.list('line-a')[0]?.id, 'b');
  assert.equal(JSON.stringify(store.dto('b')).includes('generation'), false);
  db.close();
});
