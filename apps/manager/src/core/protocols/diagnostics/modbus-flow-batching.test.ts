import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildModbusDiagnosticFlow } from './modbus-flow.ts';

function harness(quantity = 600) {
  const config = { taskId: 'batch-task', readerId: 'batch-reader', host: '192.0.2.1', port: 502,
    unitId: 7, registerType: 'HoldingRegister' as const, address: 100, quantity,
    clientTimeout: 1000, reconnectTimeout: 500, expiresAt: 30000 };
  const built = buildModbusDiagnosticFlow(config);
  const controller = built.flow.nodes.find(node => node.type === 'function')!;
  const program = String(controller.func);
  const values = new Map<string, unknown>();
  let contextAccesses = 0;
  let now = 1000;
  const sandbox = vm.createContext({ flow: { get: (key: string) => { contextAccesses++; return values.get(key); }, set: (key: string, value: unknown) => { contextAccesses++; values.set(key, value); } },
    env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager:9100' : 'fixture-ingest' }, Date: { now: () => now }, msg: {} });
  const initialize = () => vm.runInContext(`(function(){${String(controller.initialize || '')}})()`, sandbox);
  initialize();
  const run = (msg: Record<string, unknown>) => {
    sandbox.msg = structuredClone(msg);
    return vm.runInContext(`(function(){${program}})()`, sandbox) as (Record<string, unknown> | null)[] | null;
  };
  const claim = run({ status: { source: { id: config.readerId }, fill: 'green', shape: 'dot', text: 'active' } })![0]!;
  const read = run({ ...claim, statusCode: 200, payload: { leaseToken: 'b'.repeat(43), deadline: 12000 } })![1]!;
  const reply = (request: Record<string, unknown>, payload: number[]) => run({ ...request, payload, modbusRequest: request.payload });
  return { built, run, read, reply, now: (value: number) => { now = value; }, get contextAccesses() { return contextAccesses; },
    restart: () => { vm.runInContext(`(function(){${String(controller.finalize || '')}})()`, sandbox); initialize(); } };
}

test('600-register trial reads five serial native requests and reports one complete ordered result', () => {
  const h = harness();
  assert.ok(h.built.flow.nodes.some(node => node.type === 'modbus-flex-getter'));
  assert.equal(h.built.flow.nodes.filter(node => node.type === 'modbus-client').length, 0);
  assert.equal(h.built.flow.configs!.length, 1);
  const words = Array.from({ length: 600 }, (_, index) => index);
  // The two words of a 32-bit point straddle request 1 and request 2.
  words[124] = 0x4120; words[125] = 0;
  let request = h.read;
  for (let index = 0; index < 5; index++) {
    const quantity = index === 4 ? 100 : 125;
    assert.deepEqual(JSON.parse(JSON.stringify(request.payload)), { fc: 3, unitid: 7, address: 100 + index * 125, quantity });
    const out = h.reply(request, words.slice(index * 125, index * 125 + quantity))!;
    if (index < 4) {
      assert.equal(out[2], null, 'partial read is never a successful callback');
      assert.ok(out[1], 'next request follows the previous successful response');
      const previous = request; request = out[1]!;
      assert.equal(h.reply(previous, words.slice(index * 125, index * 125 + quantity)), null, 'late duplicate block is ignored');
    } else {
      assert.equal(out[1], null);
      const result = out[2]!.payload as { registers: number[]; durationMs: number };
      assert.deepEqual(Array.from(result.registers), words);
      const data = Buffer.alloc(4); data.writeUInt16BE(result.registers[124]!, 0); data.writeUInt16BE(result.registers[125]!, 2);
      assert.equal(data.readFloatBE(0), 10);
      assert.equal(h.reply(request, words.slice(500)), null);
    }
  }
});

test('middle native failure returns no partial success and never requests later blocks', () => {
  const h = harness();
  const second = h.reply(h.read, Array(125).fill(1))![1]!;
  const failed = h.run({ ...second, error: { message: 'Modbus exception fixture-private-detail', source: { id: 'batch-reader' } } })!;
  assert.equal(failed[1], null);
  assert.equal((failed[2]!.payload as Record<string, unknown>).errorCode, 'READ_FAILED');
  assert.equal((failed[2]!.payload as Record<string, unknown>).registers, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-private-detail/);
  assert.equal(h.reply(second, Array(125).fill(2)), null);
});

test('each block has its own bounded deadline and timeout does not leave an aggregate success', () => {
  const h = harness();
  h.now(2000);
  const second = h.reply(h.read, Array(125).fill(1))![1]!;
  h.now(3300);
  const timedOut = h.run({ _tleDiagnosticTick: true })!;
  assert.equal(timedOut[1], null);
  assert.equal((timedOut[2]!.payload as Record<string, unknown>).errorCode, 'READ_TIMEOUT');
  assert.equal((timedOut[2]!.payload as Record<string, unknown>).registers, undefined);
  assert.equal(h.reply(second, Array(125).fill(2)), null);
});

test('native not-ready failure without a Catch source still fails its matching block', () => {
  const h = harness();
  const failed = h.run({ ...h.read, payload: '', error: new Error('Inject while node is not ready for input.') })!;
  assert.equal((failed[2]!.payload as Record<string, unknown>).errorCode, 'CONNECT_FAILED');
  assert.equal(failed[1], null);
});

test('ephemeral diagnostic state never reads or writes configured persistent flow context', () => {
  const h = harness();
  h.reply(h.read, Array(125).fill(1));
  assert.equal(h.contextAccesses, 0);
});

test('a restarted Function discards the in-flight round and cannot resume it from late data', () => {
  const h = harness();
  const second = h.reply(h.read, Array(125).fill(1))![1]!;
  h.restart();
  assert.equal(h.reply(second, Array(125).fill(2)), null);
  const request = h.run({ status: { source: { id: 'batch-reader' }, fill: 'green', shape: 'dot', text: 'active' } })!;
  assert.equal(request[1], null, 'restarted VM must consult the one-use persisted lease before reading');
  assert.ok(request[0]);
  assert.equal(h.run({ ...request[0]!, statusCode: 409, payload: { code: 'CLAIM_CLOSED' } }), null);
  h.now(5000);
  assert.equal(h.run({ _tleDiagnosticTick: true }), null);
});
