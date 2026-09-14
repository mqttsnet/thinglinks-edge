import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';
import { presenceFlow, type PresenceFlowConfig } from './presence-flow.ts';

type Msg = Record<string, any>; // Fixture messages model the dynamic Node-RED message boundary.
function fixture(changesOnly = false, extra: Partial<PresenceFlowConfig> = {}) {
  const nodes = presenceFlow({ nodeId: 'plc', serviceCode: 'telemetry', protocol: 's7', sourceIds: ['input', 'connection'], changesOnly, failureWindowMs: 10000, ...extra });
  const observer = nodes.find(n => n.id === 'presence')!;
  let now = 1000;
  const sandbox = createContext({ Date: { now: () => now }, node: { id: 'remapped.observer', status() {}, warn() {} }, env: { get: (key: string) => key === 'TLE_MANAGER_URL' ? 'http://manager:9100' : 'fixture-token' } });
  const execute = (source: unknown, msg: Msg = {}) => { sandbox.msg = msg; return new Script(`(function(msg){${String(source)}})(msg)`).runInContext(sandbox); };
  execute(observer.initialize);
  const run = (msg: Msg) => JSON.parse(JSON.stringify(execute(observer.func, msg) ?? null)) as (Msg | null)[] | null;
  const tick = () => run({ _msgid: 'fresh-runtime', _tlePresenceTick: true });
  function activate() {
    const challenge = tick()![1]!;
    assert.equal(challenge.payload.observerId, 'remapped.observer');
    const activation = run({ ...challenge, statusCode: 200, payload: { ticket: 'ticket', expectedRevision: 0, expiresAt: now + 30000 } })![1]!;
    assert.equal(activation.payload.runNonce, challenge.payload.runNonce);
    run({ ...activation, statusCode: 200, payload: { observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 1, nextSequence: 1, leaseExpiresAt: now + 60000 } });
    return { challenge, activation };
  }
  const sample = (temperature = 26) => run({ payload: { temperature }, nodeId: 'plc', serviceId: 'telemetry' });
  const status = (text: string, fill = text === 'online' ? 'green' : 'red') => run({ _tlePresenceSource: true, status: { source: { id: 'input' }, text, fill, shape: 'dot' } });
  return { nodes, run, tick, sample, status, activate, time: (time: number) => { now = time; }, finalize: () => execute(observer.finalize), initialize: () => execute(observer.initialize) };
}

test('presence uses runtime identity, orders decoded samples and suppresses only unchanged Cloud reporting', () => {
  const f = fixture(true); assert.equal(f.sample(), null); f.activate();
  const first = f.sample()![0]!; assert.deepEqual(first.payload.values, { temperature: 26 });
  assert.deepEqual(first.payload.__tlePresence, { version: 1, observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 1, sequence: 1, kind: 'sample', report: true });
  const unchanged = f.sample()![0]!; assert.equal(unchanged.payload.__tlePresence.report, false); assert.equal(unchanged.payload.__tlePresence.sequence, 2);
  assert.equal(f.sample(27)![0]!.payload.__tlePresence.report, true);
  assert.equal(first.headers, undefined); assert.equal(JSON.stringify(first).includes('fixture-token'), false);
});

test('multi-service samples use one observer sequence and one all-service change decision', () => {
  const f = fixture(true, { serviceCodes: ['environment', 'power'] }); f.activate();
  const incoming = { nodeId: 'plc', serviceId: 'environment', payload: { value: 25 }, _tleServices: [
    { serviceCode: 'environment', values: { value: 25 } }, { serviceCode: 'power', values: { value: 8 } },
  ] };
  const first = f.run(incoming)![0]!;
  assert.deepEqual(first.payload.services, incoming._tleServices);
  assert.equal(first.payload.values, undefined);
  assert.equal(first._tleServices, undefined);
  assert.equal(first.payload.__tlePresence.sequence, 1);
  assert.equal(first.payload.__tlePresence.report, true);
  assert.equal(f.run(incoming)![0]!.payload.__tlePresence.report, false);
  incoming._tleServices[1]!.values.value = 9;
  const changed = f.run(incoming)![0]!;
  assert.equal(changed.payload.__tlePresence.sequence, 3);
  assert.equal(changed.payload.__tlePresence.report, true);
});

test('a configured service may submit a scalar subscription sample without opening arbitrary service routing', () => {
  const f = fixture(false, { serviceCodes: ['environment', 'power'] }); f.activate();
  assert.equal(f.run({ nodeId: 'plc', serviceId: 'forged', payload: { value: 1 } }), null);
  const sample = f.run({ nodeId: 'plc', serviceId: 'power', payload: { value: 8 } })![0]!;
  assert.equal(sample.serviceId, 'power');
  assert.deepEqual(sample.payload.values, { value: 8 });
});

test('S7 green does not synthesize online; sustained native unavailability does and recovery requires new data', () => {
  const f = fixture(true); f.activate(); f.sample();
  assert.equal(f.status('online'), null); assert.equal(f.status('offline'), null);
  f.time(10999); assert.equal(f.tick(), null); f.time(11000);
  const tick = f.tick()!; const offline = tick[0]!; assert.equal(offline.payload.__tlePresence.online, false); assert.equal(offline.payload.__tlePresence.kind, 'status'); assert.equal(offline.payload.values, undefined);
  assert.equal(f.sample(), null, 'queued sample cannot revive a disconnected source');
  f.run({ ...tick[1]!, statusCode: 200, payload: { observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 1, nextSequence: 3, leaseExpiresAt: 71000 } });
  assert.equal(f.status('online'), null); const recovery = f.sample()![0]!;
  assert.equal(recovery.payload.__tlePresence.kind, 'sample'); assert.equal(recovery.payload.__tlePresence.report, true);
});

test('unrelated red status and decode errors do not mark physical communication unavailable', () => {
  const f = fixture(); f.activate(); f.sample();
  f.status('invalid payload'); f.run({ error: { source: { id: 'decode' }, message: 'ECONNREFUSED-shaped application error' } });
  f.time(15000); const out = f.tick(); assert.equal(out?.[0] ?? null, null);
});

test('exact native connection errors produce false without waiting, never copying details into uplink', () => {
  const f = fixture(); f.activate(); f.sample();
  const result = f.run({ _tlePresenceSource: true, error: { source: { id: 'connection' }, message: 'connect ECONNREFUSED 192.0.2.2:102' } })![0]!;
  assert.equal(result.payload.__tlePresence.online, false); assert.equal(JSON.stringify(result).includes('192.0.2.2'), false);
});

test('renew does not alter reporting sequence, while rotated generation drops old data until a fresh sample', () => {
  const f = fixture(true); f.activate(); f.sample(); f.time(12000);
  const renew = f.tick()![1]!; assert.match(renew.url, /\/renew$/);
  assert.equal(f.sample(), null, 'do not submit samples while the generation renewal is unresolved');
  f.run({ ...renew, statusCode: 200, payload: { observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 2, nextSequence: 1, leaseExpiresAt: 72000 } });
  const next = f.sample()![0]!; assert.equal(next.payload.__tlePresence.generation, 2); assert.equal(next.payload.__tlePresence.sequence, 1); assert.equal(next.payload.__tlePresence.report, true);
});

test('conflict is terminal, failed renew never reclaims, and old callbacks cannot activate a restarted function', () => {
  const f = fixture(); const { activation } = f.activate(); f.time(12000); const renew = f.tick()![1]!;
  f.run({ ...renew, statusCode: 409, payload: { code: 'OBSERVER_RUN_CONFLICT' } });
  f.time(80000); assert.equal(f.tick(), null); assert.equal(f.sample(), null);
  f.initialize(); assert.equal(f.run({ ...activation, statusCode: 200, payload: { observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 1, nextSequence: 1, leaseExpiresAt: 100000 } }), null);
  f.finalize(); assert.equal(f.tick(), null);
});

test('bootstrap transport failures retry only the same nonce and never retain unbounded sample messages', () => {
  const f = fixture(); const challenge = f.tick()![1]!;
  for (let i = 0; i < 100; i++) assert.equal(f.sample(i), null);
  f.run({ ...challenge, statusCode: 503, payload: {} }); f.time(7000);
  const retry = f.tick()![1]!; assert.deepEqual(retry.payload, challenge.payload);
  assert.equal(f.nodes.some(node => node.type === 'exec'), false);
});

test('lost offline delivery is retried with a newer sequence while lease renewal remains healthy', () => {
  const f = fixture(); f.activate(); f.sample();
  const first = f.run({ _tlePresenceSource: true, error: { message: 'connect ECONNREFUSED 192.0.2.2:102' } })![0]!;
  f.time(5999); assert.equal(f.tick(), null);
  f.time(6000); const retried = f.tick()![0]!;
  assert.equal(retried.payload.__tlePresence.online, false);
  assert.equal(retried.payload.__tlePresence.sequence, first.payload.__tlePresence.sequence + 1);
});

test('changes reporting includes a full synchronization every 60 seconds even when prior submission was lost', () => {
  const f = fixture(true); f.activate(); f.sample();
  f.time(12000); const renew = f.tick()![1]!;
  f.run({ ...renew, statusCode: 200, payload: { observerId: 'remapped.observer', runNonce: 'fresh-runtime', generation: 1, nextSequence: 2, leaseExpiresAt: 72000 } });
  f.time(60999); assert.equal(f.sample()![0]!.payload.__tlePresence.report, false);
  f.time(61000); assert.equal(f.sample()![0]!.payload.__tlePresence.report, true);
  f.time(62000); assert.equal(f.sample()![0]!.payload.__tlePresence.report, false);
});


test('HTTP needs consecutive transport timeouts; a reachable 500 response clears the candidate without fake online', () => {
  const f = fixture(false, {protocol:'http-poll'}); f.activate(); f.sample();
  const timeout = () => f.run({_tlePresenceSource:true,error:{message:'request ETIMEDOUT'}});
  timeout(); f.time(6000); timeout(); f.time(11000);
  const expired = f.tick()!; assert.equal(expired[0]!.payload.__tlePresence.online,false);
  f.run({...expired[1]!,statusCode:200,payload:{observerId:'remapped.observer',runNonce:'fresh-runtime',generation:1,nextSequence:3,leaseExpiresAt:71000}});
  assert.equal(f.run({_tlePresenceSource:true,statusCode:500}),null);
  f.time(16000); assert.equal(f.tick(),null,'reachable server stops retrying negative transport evidence');
  assert.ok(f.sample(), 'next successful decoded response can recover');
});

test('TCP session close cannot disable a healthy peer and exact zero waits for prior valid data', () => {
  const f = fixture(false, {protocol:'tcp-server'});f.activate();
  const signal = (text:string) => f.run({_tlePresenceSource:true,status:{text,event:'disconnect',_session:{type:'tcp',id:'a'}}});
  assert.equal(signal('0 connections'),null);f.sample();
  assert.equal(signal('1 connections'),null);assert.equal(signal('0 connections')![0]!.payload.__tlePresence.online,false);
});

test('push silence is explicitly enabled, starts with valid data, and allows a later packet to recover', () => {
  const f = fixture(false,{protocol:'push',sourceIds:[],silenceTimeoutMs:5000});f.activate();
  f.time(6000);assert.equal(f.tick(),null,'unknown before any accepted payload');f.sample();
  f.time(10999);assert.equal(f.tick(),null);f.time(11000);
  const outputs=f.tick()!;assert.equal(outputs[0]!.payload.__tlePresence.online,false);
  f.run({...outputs[1]!,statusCode:200,payload:{observerId:'remapped.observer',runNonce:'fresh-runtime',generation:1,nextSequence:3,leaseExpiresAt:71000}});
  assert.ok(f.sample(),'silence does not close a nonexistent transport gate');
  const disabled=fixture(false,{protocol:'push',sourceIds:[],silenceTimeoutMs:0});disabled.activate();disabled.sample();disabled.time(10000);assert.equal(disabled.tick(),null);
});

test('HTTP push responds unavailable during bootstrap and renewal without retaining HTTP objects in the envelope', () => {
  const f = fixture(false,{protocol:'push',sourceIds:[],httpResponse:true});
  const incoming={payload:{temperature:26},nodeId:'plc',serviceId:'telemetry',req:{headers:{authorization:'device-secret'}},res:{marker:'response'}};
  assert.equal(f.run(incoming)![2]!.statusCode,503);
  f.activate();const sample=f.run(incoming)![0]!;
  assert.deepEqual(sample.req,incoming.req);assert.deepEqual(sample.res,incoming.res);
  assert.equal(JSON.stringify(sample.payload).includes('device-secret'),false);
  f.time(12000);f.tick();assert.equal(f.run(incoming)![2]!.statusCode,503);
  f.finalize();assert.equal(f.run(incoming)![2]!.statusCode,503);
});

test('a single HTTP timeout cannot become offline just because time passes',()=>{
 const f=fixture(false,{protocol:'http-poll'});f.activate();f.sample();
 f.run({_tlePresenceSource:true,error:{message:'ETIMEDOUT'}});f.time(11000);
 assert.equal(f.tick()![0],null);
});
test('expired activation ticket obtains a new challenge for the same run while all other conflicts remain terminal',()=>{
 const f=fixture();const first=f.tick()![1]!;
 const activation=f.run({...first,statusCode:200,payload:{ticket:'expiring',expiresAt:31000}})![1]!;
 f.time(32000);assert.equal(f.run({...activation,statusCode:409,payload:{code:'OBSERVER_TICKET_EXPIRED'}}),null);
 const challenge=f.tick()![1]!;assert.match(challenge.url,/\/challenge$/);assert.equal(challenge.payload.runNonce,first.payload.runNonce);
 const other=fixture();const request=other.tick()![1]!;other.run({...request,statusCode:409,payload:{code:'OBSERVER_RUN_CONFLICT'}});assert.equal(other.tick(),null);
});
test('persistent secure connection establishment rejection eventually marks communication unavailable, without accepting generic bad quality',()=>{
 const f=fixture(false,{protocol:'opcua-secure'});f.activate();f.sample();
 assert.equal(f.run({_tlePresenceSource:true,error:{message:'Error: Connect failed: BadCertificateRevocationUnknown'}}),null);
 f.time(10999);assert.equal(f.tick(),null);
 f.time(11000);const outputs=f.tick()!;assert.equal(outputs[0]!.payload.__tlePresence.online,false);
 f.run({...outputs[1]!,statusCode:200,payload:{observerId:'remapped.observer',runNonce:'fresh-runtime',generation:1,nextSequence:3,leaseExpiresAt:71000}});
 assert.ok(f.sample(),'only a new valid decoded result restores communication');
 const quality=fixture(false,{protocol:'opcua-secure'});quality.activate();quality.sample();quality.run({_tlePresenceSource:true,error:{message:'Read failed: BadUserAccessDenied'}});quality.time(11000);assert.equal(quality.tick()![0],null);
});
