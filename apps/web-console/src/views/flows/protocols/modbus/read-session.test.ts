import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModbusReadConnection, ProtocolDiagnosticTask } from '../../../../api/types.ts';
import { createModbusReadSession } from './read-session.ts';

const connection: ModbusReadConnection = { host: '192.0.2.1', port: 502, unitId: 1, registerType: 'HoldingRegister', address: 0, quantity: 2, clientTimeout: 2000, reconnectTimeout: 5000 };
function task(instanceId = 'a', state: ProtocolDiagnosticTask['state'] = 'connecting'): ProtocolDiagnosticTask {
  return { id: 'task-' + instanceId, instanceId, protocol: 'modbus-tcp', state, connection, deadline: Date.now() + 60000,
    cleanup: state === 'succeeded' ? 'done' : 'pending' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('a late start response is cancelled for its original instance instead of appearing under another one', async () => {
  const pending = deferred<ProtocolDiagnosticTask>(), cancelled: string[] = [];
  const session = createModbusReadSession({ start: async () => pending.promise, get: async id => task(id), list: async () => [],
    cancel: async (instance, id) => { cancelled.push(instance + '/' + id); return { ...task(instance), state: 'cancelled', cleanup: 'done' }; } });
  await session.select('a'); const start = session.start(connection); await session.select('b');
  pending.resolve(task('a')); await start;
  assert.equal(session.state.task, null); assert.deepEqual(cancelled, ['a/task-a']); session.dispose();
});

test('reopening finds pending cleanup and prevents another read until cleanup succeeds', async () => {
  let starts = 0;
  const session = createModbusReadSession({ start: async () => { starts++; return task(); }, get: async () => task(),
    list: async () => [{ ...task(), state: 'cleanup-required', cleanup: 'failed' }],
    cancel: async () => ({ ...task(), state: 'cancelled', cleanup: 'done' }) });
  await session.select('a'); await session.start(connection); assert.equal(starts, 0);
  assert.equal(session.state.task?.state, 'cleanup-required'); await session.cancel();
  assert.equal(session.state.task?.cleanup, 'done'); session.dispose();
});

test('a late status response cannot overwrite confirmed cancellation', async () => {
  const pending = deferred<ProtocolDiagnosticTask>();
  const session = createModbusReadSession({ start: async () => task(), get: async () => pending.promise, list: async () => [],
    cancel: async () => ({ ...task(), state: 'cancelled', cleanup: 'done' }) });
  await session.select('a'); await session.start(connection); const poll = session.refresh();
  await session.cancel(); pending.resolve(task()); await poll;
  assert.equal(session.state.task?.state, 'cancelled'); session.dispose();
});

test('closing an active view attempts cancellation without replaying a read', async () => {
  let cancels = 0, starts = 0;
  const session = createModbusReadSession({ start: async () => { starts++; return task(); }, get: async () => task(), list: async () => [],
    cancel: async () => { cancels++; return { ...task(), state: 'cancelled', cleanup: 'done' }; } });
  await session.select('a'); await session.start(connection); session.dispose();
  await Promise.resolve(); assert.equal(starts, 1); assert.equal(cancels, 1);
});
