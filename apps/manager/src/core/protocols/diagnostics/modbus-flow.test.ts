import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildModbusDiagnosticFlow, modbusDiagnosticFingerprint } from './modbus-flow.ts';

const config = () => ({ taskId: 'a7a4cb4f-f633-48d9-87ea-9b2681d6a642', readerId: 'a5902e04-040f-4145-98c9-a0e40d86c2a7',
  host: '192.0.2.10', port: 502, unitId: 1, registerType: 'HoldingRegister' as const,
  address: 100, quantity: 2, clientTimeout: 1000, reconnectTimeout: 500, expiresAt: 30_000 });
function harness() {
  const built = buildModbusDiagnosticFlow(config());
  const fn = built.flow.nodes.find(node => node.type === 'function')!;
  const store = new Map<string, unknown>(); let now = 1000;
  const sandbox = vm.createContext({ flow: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) },
    env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager:9100' : 'fixture-ingest-token' },
    Date: { now: () => now }, node: { error: () => undefined }, msg: {} });
  return { built, now: (value: number) => { now = value; },
    run: (msg: Record<string, unknown>) => {
      sandbox.msg = structuredClone(msg);
      return vm.runInContext(`(function(){${String(fn.func)}})()`, sandbox) as (Record<string, unknown> | null)[] | null;
    },
  };
}
function ready(h: ReturnType<typeof harness>) {
  const getter = h.built.flow.nodes.find(node => node.type === 'modbus-getter')!;
  return h.run({ status: { source: { id: getter.id }, fill: 'green', shape: 'dot', text: 'active' } });
}
function claimed(h: ReturnType<typeof harness>, request: Record<string, unknown>, deadline = 10_000) {
  return h.run({ ...request, statusCode: 200, payload: { leaseToken: 'a'.repeat(43), deadline } });
}

test('diagnostic uses fixed official getter and tab-private client without cloud nodes or stored credentials', () => {
  const { flow, nodeIds, fingerprint } = buildModbusDiagnosticFlow(config());
  const getter = flow.nodes.find(node => node.type === 'modbus-getter')!;
  assert.equal(getter.dataType, 'HoldingRegister'); assert.equal(getter.adr, '100'); assert.equal(getter.quantity, '2');
  assert.equal(getter.keepMsgProperties, true); assert.equal(getter.delayOnStart, false);
  assert.equal(flow.configs?.[0]?.bufferCommands, false);
  assert.equal(flow.configs?.[0]?.z, flow.id);
  assert.equal(getter.server, flow.configs?.[0]?.id);
  assert.equal(new Set(nodeIds).size, nodeIds.length);
  assert.equal(fingerprint, modbusDiagnosticFingerprint(flow));
  assert.ok(flow.nodes.every(node => !['tl-device', 'tl-uplink', 'exec', 'modbus-read'].includes(node.type)));
  assert.doesNotMatch(JSON.stringify(flow), /fixture-ingest-token/);
  assert.match(JSON.stringify(flow), /TLE_INGEST_TOKEN/);
  assert.throws(() => buildModbusDiagnosticFlow({ ...config(), registerType: 'Coil' as 'HoldingRegister' }));
});

test('native TCP getter preserves Unit ID 0 and 255 in both its private client and fixed read configuration', () => {
  for (const unitId of [0, 248, 255]) {
    for (const registerType of ['HoldingRegister', 'InputRegister'] as const) {
      const { flow } = buildModbusDiagnosticFlow({ ...config(), unitId, registerType });
      assert.equal(flow.configs?.[0]?.unit_id, unitId);
      const getter = flow.nodes.find(node => node.type === 'modbus-getter')!;
      assert.equal(getter.unitid, String(unitId)); assert.equal(getter.dataType, registerType);
    }
  }
  for (const unitId of [-1, 256, 0.5]) assert.throws(() => buildModbusDiagnosticFlow({ ...config(), unitId }));
});

test('getter must report active, not merely connected, before a bounded claim and one read', () => {
  const h = harness(); const getter = h.built.flow.nodes.find(node => node.type === 'modbus-getter')!;
  assert.equal(h.run({ _tleDiagnosticTick: true }), null);
  assert.equal(h.run({ status: { source: { id: getter.id }, fill: 'green', shape: 'ring', text: 'connected' } }), null);
  const request = ready(h)![0]!;
  assert.match(String(request.url), /protocol-diagnostics\/a7a4.*\/claim$/);
  assert.deepEqual(JSON.parse(JSON.stringify(request.payload)), { readerId: config().readerId });
  assert.equal(ready(h), null);
  const read = claimed(h, request)![1]!;
  assert.deepEqual(JSON.parse(JSON.stringify(read.payload)), {});
  assert.equal(claimed(h, request), null, 'duplicate HTTP replies must not read twice');
  assert.equal(ready(h), null);
  h.now(1500);
  const report = h.run({ ...read, payload: [250, 42] })![2]!;
  const result = report.payload as Record<string, unknown>;
  assert.deepEqual(JSON.parse(JSON.stringify(result.registers)), [250, 42]);
  assert.equal(result.durationMs, 500);
  assert.equal(h.run({ ...read, payload: [999, 999] }), null, 'late/duplicate data must not replace the first result');
});

test('unready, expired, lost or invalid claims never trigger a getter input', () => {
  for (const body of [{ leaseToken: 'a'.repeat(43), deadline: 999 }, { leaseToken: 'a'.repeat(43), deadline: 1500 },
    { leaseToken: '', deadline: 10_000 }, { leaseToken: 'a'.repeat(43), deadline: 99_000 }]) {
    const h = harness(), request = ready(h)![0]!;
    const result = h.run({ ...request, statusCode: 200, payload: body });
    assert.ok(!result?.[1]);
  }
  const h = harness(); h.now(config().expiresAt);
  assert.equal(ready(h), null); assert.equal(h.run({ _tleDiagnosticTick: true }), null);
  const retry = harness(); const request = ready(retry)![0]!;
  retry.now(5000);
  const next = retry.run({ _tleDiagnosticTick: true })![0]!;
  assert.equal(claimed(retry, request), null, 'old claim attempt cannot win after retry');
  assert.ok(claimed(retry, next)?.[1]);
});

test('read failures and deadlines report bounded codes instead of raw device errors', () => {
  for (const [error, code] of [['connect ECONNREFUSED user:secret', 'CONNECT_FAILED'], ['device timeout token=secret', 'READ_TIMEOUT'], ['exception function=99', 'READ_FAILED']]) {
    const h = harness(), request = ready(h)![0]!, read = claimed(h, request)![1]!;
    h.now(1500);
    const report = h.run({ ...read, error: { message: error, source: { id: h.built.flow.nodes.find(node => node.type === 'modbus-getter')!.id } } })![2]!;
    assert.equal((report.payload as Record<string, unknown>).errorCode, code);
    assert.doesNotMatch(JSON.stringify(report.payload), /secret|function=99/);
  }
  const h = harness(), read = claimed(h, ready(h)![0]!)![1]!;
  h.now(2500);
  const timeout = h.run({ _tleDiagnosticTick: true })![2]!;
  assert.equal((timeout.payload as Record<string, unknown>).errorCode, 'READ_TIMEOUT');
  assert.equal(h.run({ ...read, payload: [1, 2] }), null);
});

test('reconnecting lifecycle status cannot overwrite the native timeout cause of an in-flight read', () => {
  for (const text of ['failure', 'broken', 'retrying after 500 msec.', 'closed']) {
    const h = harness(), read = claimed(h, ready(h)![0]!)![1]!;
    h.now(2000);
    const source = { id: config().readerId };
    assert.equal(h.run({ status: { source, fill: 'red', shape: 'ring', text } }), null);
    const report = h.run({ ...read, error: { message: 'Timed out', source } })![2]!;
    assert.equal((report.payload as Record<string, unknown>).errorCode, 'READ_TIMEOUT');
  }
});

test('only matching lease results with the exact bounded uint16 quantity are accepted', () => {
  for (const payload of [[1], [1, 2, 3], [-1, 2], [1.5, 2], [65536, 2], 'invalid']) {
    const h = harness(), read = claimed(h, ready(h)![0]!)![1]!;
    const report = h.run({ ...read, payload })![2]!;
    assert.equal((report.payload as Record<string, unknown>).errorCode, 'INVALID_RESPONSE');
  }
  const h = harness(), read = claimed(h, ready(h)![0]!)![1]!;
  assert.equal(h.run({ ...read, _tleDiagnostic: { ...(read._tleDiagnostic as object), leaseToken: 'wrong' }, payload: [1, 2] }), null);
});

test('claim retries stop at five attempts and result retries never repeat the physical read', () => {
  const claims = harness(); let count = ready(claims)?.[0] ? 1 : 0;
  for (let time = 4000; time <= 28_000; time += 3000) {
    claims.now(time);
    const out = claims.run({ _tleDiagnosticTick: true });
    if (out?.[0]) count++;
    assert.ok(!out?.[1]);
  }
  assert.equal(count, 5);
  const h = harness(), read = claimed(h, ready(h)![0]!)![1]!;
  h.now(1500); const first = h.run({ ...read, payload: [1, 2] })![2]!;
  h.now(4500); const retry = h.run({ _tleDiagnosticTick: true })!;
  assert.equal(retry[1], null);
  assert.deepEqual(JSON.parse(JSON.stringify(retry[2]!.payload)), JSON.parse(JSON.stringify(first.payload)));
  assert.equal(h.run({ ...first, statusCode: 200 }), null, 'out-of-order first HTTP acknowledgement ignored');
  assert.equal(h.run({ ...retry[2]!, statusCode: 200 }), null);
  h.now(7500); assert.equal(h.run({ _tleDiagnosticTick: true }), null);
});

test('temporary deployment-not-ready 503 responses allow five-second verification without granting a second read', () => {
  const h = harness(); let request = ready(h)![0]!;
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(h.run({ ...request, statusCode: 503, payload: { code: 'NOT_READY' } }), null);
    h.now(2000 + attempt * 1000);
    request = h.run({ _tleDiagnosticTick: true })![0]!;
    assert.ok(request, `deployment is still verifying at attempt ${attempt}`);
  }
  assert.ok(claimed(h, request, 20_000)?.[1]);
  assert.equal(claimed(h, request, 20_000), null);
  const denied = harness(), deniedRequest = ready(denied)![0]!;
  assert.equal(denied.run({ ...deniedRequest, statusCode: 409, payload: {} }), null);
  denied.now(5000); assert.equal(denied.run({ _tleDiagnosticTick: true }), null);
});

test('fingerprint tolerates assigned tab id/order/runtime users but rejects changed nodes or foreign users', () => {
  const built = buildModbusDiagnosticFlow(config());
  const assigned = structuredClone(built.flow); assigned.id = 'assigned-by-node-red';
  for (const node of [...assigned.nodes, ...assigned.configs!]) node.z = assigned.id;
  assigned.nodes.reverse(); assigned.configs![0]!._users = [assigned.nodes.find(node => node.type === 'modbus-getter')!.id];
  assert.equal(modbusDiagnosticFingerprint(assigned), built.fingerprint);
  assigned.nodes[0]!.name = 'user edited';
  assert.notEqual(modbusDiagnosticFingerprint(assigned), built.fingerprint);
  assigned.configs![0]!._users = ['unrelated-production-reader'];
  assert.throws(() => modbusDiagnosticFingerprint(assigned), /其他流程/);
});
