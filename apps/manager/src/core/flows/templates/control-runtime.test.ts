import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  bindingPollScript,
  nextCommandScript,
  claimCommandScript,
  commandResultScript,
  resultDeliveredScript,
  networkAckScript,
} from './control-runtime.ts';

const config = {
  nodeId: 'device-1',
  serviceCode: 'env',
  commands: [{ cmd: 'setTemp', param: 'value', property: 'temperature' }],
};
function harness() {
  const store = new Map<string, unknown>();
  const errors: string[] = [];
  const context = {
    Buffer,
    Date,
    node: { id: 'consumer-1', error: (s: string) => errors.push(s), send: () => {} },
    flow: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v) },
    env: {
      get: (k: string) => ({ TLE_MANAGER_URL: 'http://manager', TLE_INGEST_TOKEN: 'fixture-token' })[k],
    },
  };
  return {
    store,
    errors,
    run(script: string, msg: Record<string, unknown> = {}) {
      return runInNewContext(`(function(msg){${script}})(msg)`, { ...context, msg });
    },
  };
}
test('binding and polling use instance identity, never a device-controlled URL', () => {
  const h = harness();
  const binding = h.run(bindingPollScript(config))[0];
  assert.equal(binding.payload.consumerId, 'consumer-1');
  assert.equal(binding.url, 'http://manager/api/edge/command-bindings');
  const next = h.run(nextCommandScript(config), { ...binding, statusCode: 200 });
  assert.equal(next.url, 'http://manager/api/edge/commands/next');
  assert.equal(next.payload.consumerId, 'consumer-1');
});
test('leased command prevents overlapping polls and retains retryable execution result', () => {
  const h = harness();
  const command = {
    id: 'job-1',
    leaseToken: 'lease-1', leaseDeadline: Date.now() + 30000,
    mid: 1,
    deviceIdentification: 'device-1',
    serviceCode: 'env',
    cmd: 'setTemp',
    params: { value: 30 },
  };
  h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
  assert.equal(h.run(bindingPollScript(config)), null);
  const response = h.run(commandResultScript('s7', true), { _tleCommand: command, payload: 30 });
  assert.equal(response.payload.ok, true);
  assert.equal(response.url, 'http://manager/api/edge/commands/job-1/result');
  h.run(resultDeliveredScript(), { ...response, statusCode: 503 });
  const retried = h.run(bindingPollScript(config));
  assert.equal(retried[0], null);
  assert.equal(retried[1].payload.leaseToken, 'lease-1');
  h.run(resultDeliveredScript(), { ...response, statusCode: 200 });
  assert.ok(h.run(bindingPollScript(config))[0]);
});
test('a write failure yields failed receipt and an unrelated reply cannot acknowledge a command', () => {
  const h = harness();
  const command = { id: 'job-1', leaseToken: 'lease-1', leaseDeadline: Date.now() + 30000, params: { value: 30 } };
  h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
  const reply = h.run(commandResultScript('http', true), {
    _tleCommand: command,
    statusCode: 202,
    payload: { ok: true },
  });
  assert.equal(reply.payload.ok, false);
  assert.equal(h.run(commandResultScript('s7', true), { payload: 30 }), null);
});

test('TCP and UDP acknowledgement scripts compile and correlate both successful and failed replies', () => {
  for (const protocol of ['tcp', 'udp'] as const)
    for (const ok of [true, false]) {
      const h = harness(),
        command = { id: 'job-1', leaseToken: 'lease-1', leaseDeadline: Date.now() + 30000, params: { value: 30 } };
      h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
      assert.equal(
        h.run(networkAckScript(protocol), { payload: Buffer.from('{"requestId":"other","ok":true}') }),
        null,
      );
      const result = h.run(networkAckScript(protocol), {
        payload: Buffer.from(JSON.stringify({ requestId: 'job-1', ok })),
      });
      assert.equal(result.payload.ok, ok);
      assert.equal(result.payload.leaseToken, 'lease-1');
    }
});

test('claim requires a valid unexpired absolute Manager lease deadline without granting a fresh local lease', () => {
  const now = Date.now();
  for (const leaseDeadline of [undefined, null, String(now + 30000), Number.NaN, Infinity, 0, now - 1, Number.MAX_SAFE_INTEGER + 1, now + 0.5]) {
    const h = harness();
    const command = { id: 'job-deadline', leaseToken: 'lease', leaseDeadline, params: { value: 1 } };
    assert.equal(h.run(claimCommandScript(), { statusCode: 200, payload: { command } }), null);
    assert.equal(h.store.get('__tle_control_pending'), undefined);
    assert.ok(h.errors.some(error => error.includes('租约')));
  }
  const h = harness(), command = { id: 'job-deadline', leaseToken: 'lease', leaseDeadline: now + 30000, params: { value: 1 } };
  const claimed = h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
  assert.equal(claimed._tleCommand.leaseDeadline, command.leaseDeadline);
  assert.equal((h.store.get('__tle_control_pending') as { command: typeof command }).command.leaseDeadline, command.leaseDeadline);
});

test('unknown device errors never stringify structured objects or forward credential-bearing detail', () => {
  for (const message of [
    { code: 'TIMEOUT', credentials: { password: 'fixture-sensitive-value' } },
    { toString: () => { throw new Error('object must not be coerced'); } },
    '[object Object]',
    'Connection failed: password=fixture-sensitive-value token=fixture-token-value',
  ]) {
    const h = harness(), command = { id: 'error-case', leaseToken: 'lease', leaseDeadline: Date.now() + 30000, params: { value: 5 } };
    h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
    const reply = h.run(commandResultScript('modbus-tcp', false), { _tleCommand: command, _tleWriteAttempted: true, error: { message } });
    assert.equal(reply.payload.ok, false); assert.equal(reply.payload.unknown, true);
    assert.match(reply.payload.error, /^设备执行结果未知：/);
    assert.doesNotMatch(reply.payload.error, /\[object Object\]|fixture-sensitive-value|fixture-token-value|credentials/);
    assert.equal(h.store.get('__tle_control_pending'), undefined);
    assert.ok(h.store.get('__tle_control_result'), 'only the receipt remains retryable');
  }
});

test('safe error summaries preserve timeout and explicit failure semantics without copying raw details', () => {
  for (const attempted of [true, false]) {
    const h = harness(), command = { id: 'timeout-case', leaseToken: 'lease', leaseDeadline: Date.now() + 30000, params: { value: 5 } };
    h.run(claimCommandScript(), { statusCode: 200, payload: { command } });
    const reply = h.run(commandResultScript('modbus-tcp', false), { _tleCommand: command, _tleWriteAttempted: attempted, error: { message: 'Error: Batch write failed: BadTimeout' } });
    assert.equal(reply.payload.ok, false); assert.equal(reply.payload.unknown, attempted ? true : undefined);
    assert.match(reply.payload.error, /超时/);
  }
});
