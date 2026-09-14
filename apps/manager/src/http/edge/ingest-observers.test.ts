import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { registerIngest } from './ingest.ts';
import { registerField } from './field.ts';
import type { HttpContext } from '../context.ts';

function fixture() {
  const db = openDb(':memory:');
  for (const id of ['i', 'j']) db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES (?,?,'test',512,0.5,'/red/','x')").run(id, id);
  const tokens = new Map([['token-i', 'i'], ['token-j', 'j']]);
  const observed: { instanceId: string; nodeId: string; state: boolean | undefined; fresh: boolean }[] = [];
  const app = Fastify();
  const context = {
    config: { basePath: '' }, db,
    repo: { allIngestTokens: () => tokens, ingestToken: (id: string) => `token-${id}` },
    guard: () => ({ username: 'a' }),
    visibleOnly: (_user: unknown, rows: unknown[]) => rows,
    presence: {
      observeUplink: () => { throw new Error('observer mode must use aggregate'); },
      observeOffline: () => { throw new Error('observer mode must use aggregate'); },
      observeAggregate: (instanceId: string, nodeId: string, state: boolean | undefined, fresh: boolean) => observed.push({ instanceId, nodeId, state, fresh }),
    },
  } as unknown as HttpContext;
  registerIngest(app, context);
  registerField(app, context);
  const send = (path: string, payload: Record<string, unknown>, owner = 'i') => app.inject({ method: 'POST', url: `/api/edge/${path}`, headers: { authorization: `Bearer token-${owner}` }, payload });
  const activate = async (observerId: string, runNonce: string, owner = 'i') => {
    const scope = { nodeId: 'd', observerId, runNonce };
    const challenge = await send('observers/challenge', scope, owner);
    assert.equal(challenge.statusCode, 200, challenge.body);
    const active = await send('observers/activate', { ...scope, ticket: challenge.json().ticket }, owner);
    assert.equal(active.statusCode, 200, active.body);
    return { ...scope, generation: active.json().generation };
  };
  const event = (run: { observerId: string; runNonce: string; generation: number }, sequence: number, values?: Record<string, unknown>, online = false) => ({
    nodeId: 'd', serviceId: 'telemetry', data: {
      __tlePresence: { version: 1, observerId: run.observerId, runNonce: run.runNonce, generation: run.generation, sequence, kind: values ? 'sample' : 'status', ...(values ? {} : { online }) },
      ...(values ? { values } : {}),
    },
  });
  const online = () => (db.prepare("SELECT online FROM field_device WHERE instance_id='i' AND node_id='d'").get() as { online: number }).online;
  const close = async () => { await app.close(); db.close(); };
  return { db, app, observed, send, activate, event, online, close };
}

test('observer ingestion orders samples and failures; healthy peers protect one device and statuses never become points', async () => {
  const f = fixture();
  try {
    await f.send('devices', { nodeId: 'd', name: 'Device' });
    const a = await f.activate('a', 'run-a'); const b = await f.activate('b', 'run-b');
    assert.equal((await f.app.inject('/api/field/devices')).json().devices[0].presenceState, 'unknown');
    assert.equal((await f.send('uplink', f.event(a, 1, { temperature: 25 }))).statusCode, 202);
    assert.equal((await f.send('uplink', f.event(b, 1, { humidity: 65 }))).statusCode, 202);
    assert.equal((await f.send('uplink', f.event(a, 3))).statusCode, 202);
    assert.equal(f.online(), 1, 'B remains a valid online source');
    assert.equal(f.observed.at(-1)?.fresh, false);
    assert.equal((await f.send('uplink', f.event(a, 2, { temperature: 99 }))).statusCode, 409);
    assert.equal((f.db.prepare("SELECT last_value FROM field_tag WHERE tag_id='temperature'").get() as { last_value: string }).last_value, '25');
    const at = f.db.prepare("SELECT last_seen FROM field_device WHERE instance_id='i'").get();
    assert.equal((await f.send('uplink', f.event(b, 2))).statusCode, 202);
    assert.equal(f.online(), 0);
    assert.equal((await f.app.inject('/api/field/devices')).json().devices[0].presenceState, 'offline');
    assert.equal((await f.app.inject('/api/field/summary')).json().managed.online, 0);
    assert.deepEqual(f.db.prepare("SELECT last_seen FROM field_device WHERE instance_id='i'").get(), at, 'offline is not fresh telemetry');
    assert.equal((await f.send('devices/d/status', { online: true })).statusCode, 204);
    await f.send('values', { nodeId: 'd', tagId: 'legacy', value: 1 });
    await f.send('uplink', { nodeId: 'd', serviceId: 'telemetry', data: { legacy: 2 } });
    assert.equal(f.online(), 0, 'legacy paths cannot bypass observer ordering');
    assert.equal((await f.send('uplink', f.event(a, 4, { temperature: 26 }))).statusCode, 202);
    assert.equal(f.online(), 1);
    assert.equal((await f.send('uplink', f.event(a, 3))).statusCode, 409);
    assert.deepEqual(f.db.prepare('SELECT tag_id FROM field_tag ORDER BY tag_id').all(), [{ tag_id: 'humidity' }, { tag_id: 'legacy' }, { tag_id: 'temperature' }]);
    const metrics = (await f.app.inject('/api/edge/metrics')).json();
    assert.equal(metrics.batch.pending, 4, 'three current samples and one legacy sample, no status/metadata/stale samples');
  } finally { await f.close(); }
});

test('old activation cannot take over a new run; instance identity comes from its own token', async () => {
  const f = fixture();
  try {
    const scope = { nodeId: 'd', observerId: 'a', runNonce: 'run-old' };
    const old = await f.send('observers/challenge', scope); assert.equal(old.statusCode, 200);
    const active = await f.activate('a', 'run-new');
    const conflict = await f.send('observers/activate', { ...scope, ticket: old.json().ticket });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'OBSERVER_RUN_CONFLICT');
    const repeated = await f.send('observers/challenge', scope);
    if (repeated.statusCode === 200) assert.equal((await f.send('observers/activate', { ...scope, ticket: repeated.json().ticket })).statusCode, 409);
    else assert.equal(repeated.statusCode, 409);
    assert.equal((await f.send('uplink', f.event(active, 1, { t: 7 }), 'j')).statusCode, 409);
    assert.equal(f.db.prepare('SELECT 1 FROM field_tag').get(), undefined);
    const noAuth = await f.app.inject({ method: 'POST', url: '/api/edge/observers/challenge', payload: scope });
    assert.equal(noAuth.statusCode, 401);
  } finally { await f.close(); }
});

test('invalid or failed samples cannot consume sequence numbers or create online evidence', async () => {
  const f = fixture();
  try {
    await f.send('devices', { nodeId: 'd', name: 'Device' });
    const run = await f.activate('a', 'run-a');
    const before = f.observed.length;
    for (const values of [{}, { '': 1 }]) assert.equal((await f.send('uplink', f.event(run, 1, values))).statusCode, 400);
    assert.equal(f.online(), 0); assert.equal(f.observed.length, before);
    const invalid = f.event(run, 1, { t: 1 }); invalid.data.__tlePresence.version = 99;
    assert.equal((await f.send('uplink', invalid)).statusCode, 400);
    assert.equal((await f.send('uplink', f.event(run, 1, { t: 1 }))).statusCode, 202);
    assert.equal(f.online(), 1);
    const unchanged = f.event(run, 2, { t: 1 });
    Object.assign(unchanged.data.__tlePresence, { report: false });
    assert.equal((await f.send('uplink', unchanged)).json().cloud, 'unchanged');
    assert.equal(f.observed.at(-1)?.fresh, true, 'a real unchanged sample still proves the device is available');
    assert.equal((await f.app.inject('/api/edge/metrics')).json().batch.pending, 1);
    const renewed = await f.send('observers/renew', { ...run });
    assert.equal(renewed.statusCode, 200);
    assert.equal(renewed.json().generation, run.generation);
    assert.equal(f.observed.at(-1)?.fresh, false, 'runtime lease renewal is not a new sample');
  } finally { await f.close(); }
});
