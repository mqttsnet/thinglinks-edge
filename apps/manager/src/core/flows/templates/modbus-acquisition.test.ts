import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';
import { modbusRecipe } from './builtin/modbus.ts';
import { validateParameters } from './parameters.ts';
import { modbusRoundProgram } from './modbus-acquisition.ts';
import { modbusReadPlan, modbusReadDurationMs } from './modbus-read-plan.ts';

type Message = Record<string, any>;
function fixture(quantity = 300, registerType = 'HoldingRegister', rejectPersistentContext = false) {
  const flows = modbusRecipe.build(validateParameters(modbusRecipe.parameters, {
    host: '192.0.2.10', nodeId: 'meter', serviceCode: 'telemetry', address: 100, quantity, registerType,
    clientTimeout: 1000, points: [{ source: '0', property: 'temperature', dataType: 'uint16be', scale: 1, offset: 0 }],
  }));
  const controller = flows.find(node => node.id === 'modbus-cycle');
  assert.ok(controller, 'recipe must build the cycle controller');
  const values = new Map<string, any>(), timers = new Map<number, { at: number; fn: () => void }>();
  const errors: string[] = [], sent: Message[][] = [];
  let now = 1000, timerId = 0;
  const sandbox = createContext({
    Date: { now: () => now }, Math, Buffer,
    context: {
      get: (key: string) => { if (rejectPersistentContext) throw new Error('persistent context unavailable'); return values.get(key); },
      set: (key: string, value: unknown) => { if (rejectPersistentContext) throw new Error('persistent context unavailable'); return values.set(key, value); },
    },
    node: { id: 'runtime-controller', error: (text: string) => errors.push(text), send: (output: Message[][]) => sent.push(output) },
    setTimeout: (fn: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const execute = (source: unknown, msg: Message) => { sandbox.msg = structuredClone(msg); return new Script(`(function(msg){${String(source)}})(msg)`).runInContext(sandbox) as [Message | null, Message | null] | null; };
  execute(controller.initialize, {});
  const run = (msg: Message) => execute(controller.func, msg);
  const reply = (request: Message, values?: number[]): Message => ({ ...structuredClone(request), payload: values ?? Array.from({ length: request.payload.quantity }, (_, i) => request.payload.address + i), modbusRequest: { ...request.payload } });
  return {
    run, reply, errors, sent, timers,
    poll: () => run({ _tleModbusPoll: true }),
    reset: () => execute(controller.initialize, {}),
    close: () => execute(controller.finalize, {}),
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
  };
}

test('300 registers are read as serial 125/125/50 requests and complete only after all three validated replies', () => {
  const f = fixture();
  const first = f.poll()!;
  assert.equal(first[1], null); assert.equal(first[0]?.payload.quantity, 125); assert.equal(first[0]?.payload.address, 100);
  assert.equal(f.poll(), null, 'busy sampling cycles are skipped');
  const second = f.run(f.reply(first[0]!))!;
  assert.equal(second[1], null); assert.equal(second[0]?.payload.quantity, 125); assert.equal(second[0]?.payload.address, 225);
  const third = f.run(f.reply(second[0]!))!;
  assert.equal(third[1], null); assert.equal(third[0]?.payload.quantity, 50); assert.equal(third[0]?.payload.address, 350);
  const complete = f.run(f.reply(third[0]!))!;
  assert.equal(complete[0], null);
  assert.deepEqual(Array.from(complete[1]!.payload), Array.from({ length: 300 }, (_, i) => i + 100));
  assert.equal(complete[1]!._tleModbusCycle, undefined, 'private protocol correlation never becomes telemetry');
  assert.equal(f.timers.size, 0); assert.equal(f.errors.length, 0);
  assert.ok(f.poll()?.[0], 'next scheduled round can start');
});

test('a failed middle chunk discards the round; late first/second replies cannot populate a new round', () => {
  const f = fixture(); const first = f.poll()![0]!, second = f.run(f.reply(first))![0]!;
  assert.equal(f.run({ ...second, error: { message: 'Timed out', source: { id: 'input' } } }), null);
  assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 0);
  const fresh = f.poll()![0]!;
  assert.equal(f.run(f.reply(second)), null); assert.equal(f.run(f.reply(first)), null);
  const next = f.run(f.reply(fresh))![0]!;
  assert.equal(next.payload.address, 225);
});

test('timeout expires the whole round and a later valid response cannot revive it', () => {
  const f = fixture(); const request = f.poll()![0]!;
  f.advance(2000);
  assert.equal(f.errors.length, 1); assert.equal(f.run(f.reply(request)), null);
  assert.ok(f.poll()?.[0]);
});

test('wrong native request identity, partial data, bad word values and native empty failures discard the whole round', () => {
  for (const change of [
    (reply: Message) => { reply.modbusRequest.address++; },
    (reply: Message) => { reply.modbusRequest.fc = 4; },
    (reply: Message) => { reply.modbusRequest.unitid++; },
    (reply: Message) => { reply.modbusRequest.quantity--; },
    (reply: Message) => { reply.payload.pop(); },
    (reply: Message) => { reply.payload[0] = 65536; },
    (reply: Message) => { reply.payload[0] = 1.5; },
    (reply: Message) => { reply.payload = ''; reply.error = { message: 'not ready' }; },
  ]) {
    const f = fixture(); const request = f.poll()![0]!, response = f.reply(request); change(response);
    assert.equal(f.run(response), null); assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.run(f.reply(request)), null); assert.ok(f.poll()?.[0]);
  }
});

test('duplicate and reordered chunks are ignored without aborting the active correct chunk', () => {
  const f = fixture(); const first = f.poll()![0]!, second = f.run(f.reply(first))![0]!;
  assert.equal(f.run(f.reply(first)), null);
  const future = f.reply(second); future._tleModbusCycle.index++;
  assert.equal(f.run(future), null);
  assert.ok(f.run(f.reply(second))?.[0]); assert.equal(f.errors.length, 0);
});

test('redeploy initializes a new runtime and rejects an old request even in the same millisecond', () => {
  const f = fixture(); const old = f.poll()![0]!;
  f.reset(); const current = f.poll()![0]!;
  assert.equal(f.run(f.reply(old)), null);
  assert.ok(f.run(f.reply(current))?.[0]);
});

test('FC4 and exactly 125/126/600 registers retain protocol limits and the requested total range', () => {
  for (const quantity of [125, 126, 600]) {
    const f = fixture(quantity, 'InputRegister'); let output = f.poll(); let count = 0;
    while (output?.[0]) {
      const request = output[0]; assert.equal(request.payload.fc, 4);
      assert.ok(request.payload.quantity >= 1 && request.payload.quantity <= 125);
      count += request.payload.quantity; output = f.run(f.reply(request));
    }
    assert.equal(count, quantity); assert.equal(output?.[1]?.payload.length, quantity); assert.equal(f.timers.size, 0);
  }
});

test('read plans preserve the top address boundary, range coverage and finite per-round budget', () => {
  assert.deepEqual(modbusReadPlan(65410, 126), [
    { index: 0, offset: 0, address: 65410, quantity: 125 },
    { index: 1, offset: 125, address: 65535, quantity: 1 },
  ]);
  assert.equal(modbusReadDurationMs(600, 60000), 301250);
  for (const [address, quantity] of [[65535, 2], [0, 601], [0, 0], [-1, 1], [0, 1.5]]) {
    assert.throws(() => modbusReadPlan(address!, quantity!));
  }
});

test('caller lease bounds the round and the last reply cannot cross its absolute deadline', () => {
  const sandbox = createContext({});
  const advance = new Script(`${modbusRoundProgram({ address: 10, quantity: 126, fc: 3, unitId: 1, clientTimeout: 1000 })}\nadvanceModbusRound`).runInContext(sandbox);
  const first = advance(null, { kind: 'start', nonce: 'diagnostic-lease', deadline: 1600 }, 1000);
  assert.equal(first.state.deadline, 1600);
  const next = advance(first.state, { kind: 'reply', message: {
    ...first.request, payload: Array(125).fill(3), modbusRequest: first.request.payload,
  } }, 1500);
  assert.equal(next.state.deadline, 1600);
  const expired = advance(next.state, { kind: 'reply', message: {
    ...next.request, payload: [3], modbusRequest: next.request.payload,
  } }, 1600);
  assert.equal(expired.failure, 'READ_TIMEOUT'); assert.equal(expired.complete, undefined); assert.equal(expired.state, null);
});

test('completed rapid polls retain at most one watchdog and a timer cannot discard the next chunk', () => {
  const f = fixture(126);
  for (let i = 0; i < 100; i++) {
    const first = f.poll()![0]!; assert.equal(f.timers.size, 1);
    f.advance(1); const second = f.run(f.reply(first))![0]!; assert.equal(f.timers.size, 1);
    f.advance(1); assert.equal(f.run(f.reply(second))?.[1]?.payload.length, 126); assert.equal(f.timers.size, 0);
  }
  f.advance(2000); assert.equal(f.errors.length, 0);
});

test('active sampling state never uses persistent node context and closing clears its watchdog', () => {
  const f = fixture(300, 'HoldingRegister', true);
  const first = f.poll()![0]!; assert.equal(f.timers.size, 1);
  f.close(); assert.equal(f.timers.size, 0);
  assert.equal(f.poll(), null); assert.equal(f.run(f.reply(first)), null);
  f.advance(5000); assert.equal(f.errors.length, 0);
});
