import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { commandResultScript, networkAckScript } from './control-runtime.ts';

const command = { id: 'job-1', leaseToken: 'lease-1' };
const marker = { run: 'run-1', sequence: 1, kind: 'execution' };
function classify(protocol: string, success: boolean, msg: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const input = { _tleCommand: command, _tleControl: marker, ...msg };
  const output = runInNewContext(`(function(msg){${commandResultScript(protocol, success)}})(msg)`,
    { msg: input, Buffer, node: { error: (message: string) => errors.push(message) },
      flow: { get() { assert.fail('result classification must be pure'); }, set() { assert.fail('result classification must be pure'); } } });
  return { output, errors };
}

test('protocol results preserve exact command correlation without sending a receipt independently', () => {
  const reply = classify('s7', true, { payload: 30 }).output;
  assert.deepEqual(JSON.parse(JSON.stringify(reply._tleExecutionResult)), { id: 'job-1', leaseToken: 'lease-1', ok: true });
  assert.deepEqual(reply._tleControl, marker);
  assert.equal(reply.url, undefined); assert.equal(reply.headers, undefined);
  assert.equal(classify('s7', true, { _tleCommand: undefined }).output, null);
});

test('HTTP execution needs HTTP 200 and strict positive acknowledgement', () => {
  for (const [statusCode, ack, ok, unknown] of [[200, true, true, undefined], [200, false, false, undefined],
    [202, true, false, true], [500, true, false, true], [200, undefined, false, true]]) {
    const result = classify('http', true, { statusCode, payload: { ok: ack } }).output._tleExecutionResult;
    assert.equal(result.ok, ok); assert.equal(result.unknown, unknown);
  }
});

test('OPC UA confirmation still requires a bounded Good status code', () => {
  assert.equal(classify('opcua', true, { payload: { value: 0 } }).output._tleExecutionResult.ok, true);
  for (const payload of ['Good', -1, 0x80000000, NaN, { statusCode: 'Good' }])
    assert.equal(classify('opcua', true, { payload }).output._tleExecutionResult.ok, false);
});

test('driver failures remain unknown after a possible write but explicit rejection is failure', () => {
  for (const attempted of [true, false]) {
    const result = classify('s7', false, { _tleWriteAttempted: attempted, error: { message: 'device timed out' } }).output._tleExecutionResult;
    assert.equal(result.ok, false); assert.equal(result.unknown, attempted ? true : undefined);
    assert.match(result.error, /超时/);
  }
  const explicit = classify('opcua', false, { _tleWriteAttempted: true, _tleExplicitRejection: true,
    error: { message: 'BadNotWritable' } }).output._tleExecutionResult;
  assert.equal(explicit.unknown, undefined);
});

test('structured or credential-bearing errors never enter receipt detail', () => {
  for (const message of [{ password: 'fixture-sensitive' }, { toString() { throw Error('must not coerce'); } },
    'Connection failed password=fixture-sensitive token=fixture-token']) {
    const result = classify('s7', false, { _tleWriteAttempted: true, error: { message } }).output._tleExecutionResult;
    assert.equal(result.unknown, true);
    assert.doesNotMatch(result.error, /fixture-sensitive|fixture-token|\[object Object\]/);
  }
});

test('TCP and UDP parsing only yield id/ack; the private controller decides which lease may complete', () => {
  for (const protocol of ['tcp', 'udp'] as const) {
    const script = networkAckScript(protocol);
    for (const ok of [true, false, undefined]) {
      const result = runInNewContext(`(function(msg){${script}})(msg)`, { Buffer,
        msg: { payload: Buffer.from(JSON.stringify({ requestId: 'job-1', ok })) }, node: { error() {} } });
      assert.equal(result._tleNetworkAck.id, 'job-1'); assert.equal(result._tleNetworkAck.ok, ok);
      assert.equal(result._tleCommand, undefined); assert.equal(result.url, undefined);
    }
  }
});

test('native result wrappers retain the execution generation marker with nested command correlation', () => {
  const result = classify('s7', true, { _tleCommand: undefined, _tleControl: undefined,
    input: { _tleCommand: command, _tleControl: marker } }).output;
  assert.deepEqual(result._tleControl, marker); assert.equal(result._tleExecutionResult.id, command.id);
});
