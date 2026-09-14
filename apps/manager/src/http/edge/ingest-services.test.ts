import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { ValueHistory } from '../../core/edge/history.ts';
import { registerIngest } from './ingest.ts';
import { registerField } from './field.ts';
import type { HttpContext } from '../context.ts';
import type { DataReportPayload } from '../../core/cloud/batch.ts';

test('one sequence atomically records and reports A/B services, including same-name properties and scoped history', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  const app = Fastify(); const batches: DataReportPayload[] = []; const observed: boolean[] = [];
  let resolveBatch!: () => void; const sent = new Promise<void>(resolve => { resolveBatch = resolve; });
  const ctx = { db, config: { basePath: '' }, repo: { allIngestTokens: () => new Map([['token', 'i']]), ingestToken: () => 'token' },
    guard: () => ({ username: 'admin' }), visibleOnly: (_user: unknown, rows: unknown[]) => rows,
    valueHistory: new ValueHistory(db, { maxRows: 100, minGapSec: 0 }),
    presence: { observeAggregate: (_i: string, _d: string, _s: unknown, fresh: boolean) => observed.push(fresh) },
    cloudSink: async (payload: DataReportPayload) => { batches.push(payload); resolveBatch(); },
  } as unknown as HttpContext;
  registerIngest(app, ctx); registerField(app, ctx);
  const post = (path: string, payload: object) => app.inject({ method: 'POST', url: `/api/edge/${path}`, payload, headers: { authorization: 'Bearer token' } });
  try {
    await post('devices', { nodeId: 'd', name: 'Device' });
    const scope = { nodeId: 'd', observerId: 'collector', runNonce: 'run' };
    const challenge = await post('observers/challenge', scope);
    const active = await post('observers/activate', { ...scope, ticket: challenge.json().ticket });
    const sample = { __tlePresence: { version: 1, observerId: scope.observerId, runNonce: scope.runNonce, generation: active.json().generation, sequence: 1, kind: 'sample' }, services: [
      { serviceCode: 'A', values: { temperature: 21 } }, { serviceCode: 'B', values: { temperature: 294 } },
    ] };
    const response = await post('uplink', { nodeId: 'd', serviceId: 'ignored-envelope-service', data: sample });
    assert.equal(response.statusCode, 202, response.body); assert.equal(response.json().accepted, 2);
    const tags = (await app.inject('/api/field/tags?instanceId=i&nodeId=d')).json().tags;
    assert.deepEqual(tags.map((p: { serviceCode: string; tagId: string; lastValue: unknown }) => [p.serviceCode, p.tagId, p.lastValue]), [['A', 'temperature', 21], ['B', 'temperature', 294]]);
    assert.equal((await app.inject('/api/field/tags?instanceId=i&nodeId=d&serviceCode=B')).json().tags.length, 1);
    assert.deepEqual((await app.inject('/api/field/history?instanceId=i&nodeId=d&tagId=temperature&serviceCode=A')).json().points.map((p: { value: unknown }) => p.value), [21]);
    assert.deepEqual((await app.inject('/api/field/history?instanceId=i&nodeId=d&tagId=temperature')).json().points, []);
    assert.equal(observed.filter(Boolean).length, 1);
    assert.equal((await post('uplink', { nodeId: 'd', data: sample })).statusCode, 409);
    const invalid = { ...sample, __tlePresence: { ...sample.__tlePresence, sequence: 2 }, services: [sample.services[0], { serviceCode: 'B', values: { '': 99 } }] };
    assert.equal((await post('uplink', { nodeId: 'd', data: invalid })).statusCode, 400);
    assert.equal((db.prepare('SELECT last_sequence FROM presence_observer').get() as { last_sequence: number }).last_sequence, 1);
    await sent;
    assert.equal(batches.length, 1); const services = batches[0]!.devices[0]!.services;
    assert.deepEqual(services.map(s => [s.serviceCode, s.data]), [['A', { temperature: 21 }], ['B', { temperature: 294 }]]);
    assert.equal(services[0]!.eventTime, services[1]!.eventTime);
  } finally { await app.close(); db.close(); }
});
