import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import Fastify from 'fastify';
import { openDb } from '../../db.ts';
import { registerIngest } from '../../../http/edge/ingest.ts';
import type { HttpContext } from '../../../http/context.ts';
import { renderBuiltinTemplate } from './catalog.ts';
import { s7Recipe } from './builtin/s7.ts';
import { parameterDefaults } from './parameters.ts';

// Uses the real generated program, HTTP handlers, observer store and SQLite. The
// native Node-RED HTTP request transport and PLC are exercised by the live fixture.
test('generated S7 observer bootstrap, decoded sample/report:false and renew match the real Manager contract', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  const app = Fastify();
  const ctx = { guard: () => ({ username: 'fixture' }), config: { basePath: '' }, db, repo: { allIngestTokens: () => new Map([['fixture-token', 'i']]), ingestToken: () => 'fixture-token' } } as unknown as HttpContext;
  registerIngest(app, ctx);
  try {
    const params = { ...parameterDefaults(s7Recipe.parameters), nodeId: 'plc', serviceCode: 'telemetry', host: '192.0.2.2', changesOnly: true, points: [{ source: 'DB1,WORD100', property: 'temperature', dataType: 'number', scale: 0.1, offset: 1 }] };
    const nodes = renderBuiltinTemplate(s7Recipe.id, params)!.flows;
    const observer = nodes.find(n => n.id === 'presence')!;
    let now = Date.now();
    const vm = createContext({ Buffer, Date: { now: () => now }, env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager' : 'fixture-token' }, node: { id: 'real-remapped-id', status() {}, error(message: string) { throw new Error(message); } } });
    const execute = (script: unknown, msg: Record<string, unknown> = {}) => { vm.msg = msg; return new Script(`(function(msg){${String(script)}})(msg)`).runInContext(vm); };
    const request = async (msg: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url: new URL(String(msg.url)).pathname, headers: msg.headers as Record<string, string>, payload: msg.payload as Record<string, unknown> });
      assert.equal(response.statusCode, 200, response.body);
      return execute(observer.func, { ...msg, statusCode: response.statusCode, payload: response.json() });
    };
    execute(observer.initialize);
    const started = execute(observer.func, { _msgid: 'unique-runtime', _tlePresenceTick: true });
    const challenge = await request(started[1]); await request(challenge[1]);
    const sendSample = async () => {
      const decoded = execute(nodes.find(n => n.id === 'decode')!.func, { payload: { temperature: 503 } });
      const [sample] = execute(observer.func, decoded);
      assert.equal(sample.payload.values.temperature, 51.300000000000004);
      const response = await app.inject({ method: 'POST', url: '/api/edge/uplink', headers: { authorization: 'Bearer fixture-token' }, payload: { nodeId: sample.nodeId, serviceId: sample.serviceId, data: sample.payload } });
      assert.equal(response.statusCode, 202, response.body);
      return response.json();
    };
    await sendSample(); assert.equal((await sendSample()).cloud, 'unchanged');
    const row = db.prepare('SELECT state,last_sequence FROM presence_observer').get();
    assert.deepEqual(row, { state: 'online', last_sequence: 2 });
    assert.equal((await app.inject('/api/edge/metrics')).json().batch.pending, 1);
    now += 11000; const renewal = execute(observer.func, { _msgid: 'tick-only', _tlePresenceTick: true });
    await request(renewal[1]);
    assert.deepEqual(db.prepare('SELECT state,last_sequence FROM presence_observer').get(), row);
    await sendSample(); assert.equal((db.prepare('SELECT last_sequence FROM presence_observer').get() as { last_sequence: number }).last_sequence, 3);
  } finally { await app.close(); db.close(); }
});

test('generated OPC subscription and health readers keep independent ordered observers and unchanged Good reads are fresh evidence', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  const app = Fastify();
  const observed: { online: boolean | undefined; fresh: boolean }[] = [];
  registerIngest(app, { config: { basePath: '' }, db, repo: { allIngestTokens: () => new Map([['fixture-token', 'i']]), ingestToken: () => 'fixture-token' },
    presence: { observeAggregate: (_i: string, _d: string, online: boolean | undefined, fresh: boolean) => observed.push({ online, fresh }) },
  } as unknown as HttpContext);
  try {
    const nodes = renderBuiltinTemplate('builtin:opcua', { nodeId: 'plc', serviceCode: 'telemetry', action: 'subscribe', endpoint: 'opc.tcp://192.0.2.1:4840', interval: 1,
      points: [{ source: 'ns=1;s=Temperature', property: 'temperature', dataType: 'Double', scale: 0.1, offset: 1 }] })!.flows;
    let now = Date.now();
    const http = async (path: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer fixture-token' }, payload });
    await http('/api/edge/devices', { nodeId: 'plc' });
    async function collector(prefix: string) {
      const observer = nodes.find(n => n.id === prefix + 'presence')!, decode = nodes.find(n => n.id === prefix + 'decode')!;
      const vm = createContext({ Buffer, Date: { now: () => now }, env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager' : 'fixture-token' }, node: { id: prefix + 'runtime', status() {}, error(message: string) { throw new Error(message); } } });
      const execute = (script: unknown, msg: Record<string, unknown> = {}) => { vm.msg = msg; return new Script(`(function(msg){${String(script)}})(msg)`).runInContext(vm); };
      execute(observer.initialize);
      const start = execute(observer.func, { _msgid: prefix + 'run', _tlePresenceTick: true });
      const challenge = await http(new URL(start[1].url).pathname, start[1].payload);
      const activate = execute(observer.func, { ...start[1], statusCode: challenge.statusCode, payload: challenge.json() });
      const activated = await http(new URL(activate[1].url).pathname, activate[1].payload);
      execute(observer.func, { ...activate[1], statusCode: activated.statusCode, payload: activated.json() });
      const submit = async (msg: Record<string, any>) => {
        const response = await http('/api/edge/uplink', { nodeId: msg.nodeId, serviceId: msg.serviceId, data: msg.payload });
        assert.equal(response.statusCode, 202, response.body);
      };
      return {
        sample: async () => {
          const decoded = execute(decode.func, { topic: 'ns=1;s=Temperature', payload: 250, statusCode: 0 });
          const [sample] = execute(observer.func, decoded); await submit(sample);
        },
        fail: async () => { const result = execute(observer.func, { _tlePresenceSource: true, error: { message: 'ECONNRESET' } }); await submit(result[0]); },
      };
    }
    const subscription = await collector(''), health = await collector('health-');
    await subscription.sample(); await health.sample();
    assert.equal((db.prepare('SELECT count(*) n FROM presence_observer').get() as { n: number }).n, 2);
    await subscription.fail(); assert.deepEqual(observed.at(-1), { online: true, fresh: false });
    now += 1000; await health.sample(); assert.deepEqual(observed.at(-1), { online: true, fresh: true }, 'unchanged real health reading establishes fresh evidence');
    await subscription.sample(); await health.fail(); assert.deepEqual(observed.at(-1), { online: true, fresh: false });
    assert.equal((db.prepare("SELECT last_value FROM field_tag WHERE tag_id='temperature'").get() as { last_value: string }).last_value, '26');
  } finally { await app.close(); db.close(); }
});
