import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { controlControllerScript, CONTROL_INITIALIZE, CONTROL_FINALIZE } from './control-runtime.ts';

const config = { nodeId: 'device-1', serviceCode: '', commands: [
  { serviceCode: 'motor', cmd: 'set', param: 'value', property: 'speed' },
  { serviceCode: 'fan', cmd: 'set', param: 'value', property: 'speed' },
] };
function harness() {
  let now = 1000;
  const errors: string[] = [];
  const context = vm.createContext({ Date: { now: () => now }, Math, msg: {},
    node: { id: 'controller', error: (text: string) => errors.push(text) },
    flow: { get: () => assert.fail('control leases must not enter persistent flow context'), set: () => assert.fail('control leases must not enter persistent flow context') },
    env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager' : 'fixture-token' } });
  const run = (msg: Record<string, unknown> = { _tleControlTick: true }) => {
    context.msg = structuredClone(msg);
    return vm.runInContext(`(function(){${controlControllerScript(config)}})()`, context) as (Record<string, any> | null)[] | null;
  };
  const initialize = () => vm.runInContext(CONTROL_INITIALIZE, context);
  initialize();
  const bindings = run()![0]!;
  run({ ...bindings, statusCode: 200, payload: { accepted: 2 } });
  const poll = () => run()?.[1];
  return { run, poll, bindings, errors, now: (value: number) => { now = value; },
    prepare: (message: Record<string, any>) => run({ ...message, _tlePrepared: true })?.[5],
    restart: () => { vm.runInContext(CONTROL_FINALIZE, context); initialize(); } };
}
const command = (serviceCode = 'motor', over: Record<string, unknown> = {}) => ({ id: `job-${serviceCode}`,
  leaseToken: `lease-${serviceCode}`, leaseDeadline: 30000, deviceIdentification: 'device-1', serviceCode,
  cmd: 'set', params: { value: 20 }, ...over });
function claim(h: ReturnType<typeof harness>, poll: Record<string, any>, value = command()) {
  return h.run({ ...poll, statusCode: 200, payload: { command: value } })?.[2];
}

test('batch heartbeats declare all services and cannot trigger command acquisition themselves', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.bindings.payload)), { consumerId: 'controller', nodeId: 'device-1', services: [
    { serviceCode: 'motor', commands: [{ cmd: 'set', param: 'value' }] },
    { serviceCode: 'fan', commands: [{ cmd: 'set', param: 'value' }] },
  ] });
  assert.equal(h.run({ ...h.bindings, statusCode: 200, payload: { accepted: 2 } }), null);
  const first = h.poll()!;
  assert.equal(first.payload.serviceCode, 'motor');
  assert.equal(h.run({ ...first, statusCode: 200, payload: { command: null } }), null);
  h.now(2000);
  assert.equal(h.poll()!.payload.serviceCode, 'fan');
});

test('all services share one in-flight command while independent heartbeats stay active', () => {
  const h = harness(); const first = h.poll()!, encoded = claim(h, first)!, execute = h.prepare(encoded)!;
  assert.ok(execute);
  assert.equal(h.prepare(encoded), undefined, 'a duplicate encoded message cannot execute twice');
  assert.equal(h.poll(), undefined);
  h.now(12000);
  const heartbeat = h.run()!;
  assert.ok(heartbeat[0]); assert.equal(heartbeat[1], null); assert.equal(heartbeat[2], null);
  assert.equal(h.run({ ...heartbeat[0], statusCode: 200, payload: { accepted: 2 } }), null);
  const result = h.run({ ...execute, _tleExecutionResult: { id: 'job-motor', leaseToken: 'lease-motor', ok: true } })![3]!;
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload.result)), { value: 20 });
  assert.equal(h.poll(), undefined, 'result delivery also holds the shared connection slot');
  h.run({ ...result, statusCode: 200, payload: {} });
  h.now(13000);
  assert.equal(h.poll()!.payload.serviceCode, 'fan');
});

test('absolute expiry only emits an unknown receipt, and receipt failures never reissue writes', () => {
  const h = harness(); const execute = h.prepare(claim(h, h.poll()!, command('motor', { leaseDeadline: 5000 }))!)!;
  h.now(5000);
  const expired = h.run()![3]!;
  assert.equal(expired.payload.unknown, true); assert.equal(expired.payload.ok, false);
  assert.equal(h.run({ ...execute, _tleExecutionResult: { id: 'job-motor', leaseToken: 'lease-motor', ok: true } }), null);
  h.run({ ...expired, statusCode: 503 });
  h.now(8000);
  const retry = h.run()!;
  assert.equal(retry[2], null); assert.equal(retry[1], null); assert.deepEqual(retry[3]!.payload, expired.payload);
});

test('old or expired encoded messages cannot bypass the last dispatch gate', () => {
  const expired = harness(); const encoded = claim(expired, expired.poll()!, command('motor', { leaseDeadline: 5000 }))!;
  expired.now(5000);
  const result = expired.run({ ...encoded, _tlePrepared: true })!;
  assert.equal(result[5], null); assert.equal(result[3]!.payload.unknown, undefined);
  const restarted = harness(); const old = claim(restarted, restarted.poll()!)!;
  restarted.restart();
  assert.equal(restarted.prepare(old), undefined);
});

test('old generation and old poll replies cannot create new writes after restart or transport timeout', () => {
  const h = harness(); const poll = h.poll()!;
  h.restart();
  assert.equal(claim(h, poll), undefined);
  const current = h.run()![0]!;
  h.run({ ...current, statusCode: 200, payload: { accepted: 2 } });
  const lost = h.poll()!;
  h.now(8000); h.run();
  assert.equal(claim(h, lost), undefined);
});

test('wrong device, service, command or expired lease is never sent to the physical writer', () => {
  for (const over of [{ deviceIdentification: 'other' }, { serviceCode: 'fan' }, { cmd: 'unknown' }, { leaseDeadline: 999 }, { params: { other: 1 } }]) {
    const h = harness();
    assert.equal(claim(h, h.poll()!, command('motor', over)), undefined);
    assert.ok(h.errors.length);
  }
});

test('partial binding acknowledgement cannot unlock polling any service', () => {
  const h = harness();
  h.now(12000);
  const heartbeat = h.run()![0]!;
  h.run({ ...heartbeat, statusCode: 200, payload: { accepted: 1 } });
  h.now(13000);
  assert.equal(h.poll(), undefined);
});

test('network acknowledgement only completes the current executed command, never another service', () => {
  const h = harness(), encoded = claim(h, h.poll()!)!;
  assert.equal(h.run({ _tleNetworkAck: { id: 'job-motor', ok: true } }), null, 'not yet submitted to device');
  h.prepare(encoded);
  assert.equal(h.run({ _tleNetworkAck: { id: 'job-fan', ok: true } }), null);
  const receipt = h.run({ _tleNetworkAck: { id: 'job-motor', ok: true } })![3]!;
  assert.equal(receipt.payload.leaseToken, 'lease-motor'); assert.equal(receipt.payload.ok, true);
});
