import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db.ts';
import { ProtocolDiagnosticStore } from './store.ts';
import { validateConnection } from './validation.ts';
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
test('connection validation uses recipe defaults and refuses writes, fractional addresses and overflow', () => {
  assert.deepEqual(validateConnection({ host: '192.0.2.1' }), connection);
  for (const value of [{ host: 'x', registerType: 'Coil' }, { host: 'x', address: 0.5 }, { host: 'x', address: 65535, quantity: 2 }, { host: 'x', quantity: 126 }, { host: 'x', secret: 'never echo' }])
    assert.throws(() => validateConnection(value));
});


test('Modbus TCP trial accepts the official native 0..255 unit range without changing its default',()=>{
 assert.equal(validateConnection({host:'192.0.2.1',unitId:0}).unitId,0);
 assert.equal(validateConnection({host:'192.0.2.1',unitId:255}).unitId,255);
 for(const unitId of [-1,256])assert.throws(()=>validateConnection({host:'192.0.2.1',unitId}));
 assert.equal(validateConnection({host:'192.0.2.1'}).unitId,1);
});
