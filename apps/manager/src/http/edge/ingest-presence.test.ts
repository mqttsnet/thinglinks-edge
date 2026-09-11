import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { registerIngest } from './ingest.ts';
import type { HttpContext } from '../context.ts';

test('only authenticated and recorded real uplink triggers presence, never values, registration or replay', async () => {
  const db = openDb(':memory:'); const app = Fastify();
  db.prepare("INSERT INTO instance(id, name, image_tag, mem_limit, cpu_limit, admin_root, cred_secret) VALUES ('i', 'Test', 'test', 512, 0.5, '/red/i/', 'x')").run();
  const tokens = new Map([['test-token', 'i']]); const observed: string[][] = [];
  registerIngest(app, {
    config: { basePath: '' }, db,
    repo: { allIngestTokens: () => new Map(tokens), ingestToken: (id: string) => [...tokens].find(([, owner]) => owner === id)?.[0] },
    guard: () => ({ username: 'a' }),
    presence: { observeUplink: (i: string, d: string) => observed.push(['live', i, d]), observeOffline: (i: string, d: string) => observed.push(['offline', i, d]) },
  } as unknown as HttpContext);
  const send = (url: string, payload: Record<string, unknown>, authorized = true) => app.inject({ method: 'POST', url: `/api/edge/${url}`, ...(authorized ? { headers: { authorization: 'Bearer test-token' } } : {}), payload });
  try {
    assert.equal((await send('uplink', { nodeId: 'd', data: { t: 1 } }, false)).statusCode, 401);
    await send('devices', { nodeId: 'd', name: 'Device' });
    await send('values', { nodeId: 'd', tagId: 't', value: 1 });
    await send('devices/d/status', { online: true });
    await send('devices/missing/status', { online: false });
    assert.equal(observed.length, 0);
    assert.equal((await send('uplink', { nodeId: 'd', data: { '': 1 } })).statusCode, 400);
    await send('uplink', { nodeId: 'd', data: {} }); assert.equal(observed.length, 0);
    assert.equal((await send('uplink', { nodeId: 'd', data: { t: 2 } })).statusCode, 202);
    assert.deepEqual(observed, [['live', 'i', 'd']]);
    await send('replay', {}); assert.equal(observed.length, 1);
    await send('devices/d/status', { online: false }); assert.deepEqual(observed.at(-1), ['offline', 'i', 'd']);
    tokens.clear();
    assert.equal((await send('uplink', { nodeId: 'd', data: { t: 3 } })).statusCode, 401);
    assert.equal(observed.length, 2);
  } finally { await app.close(); db.close(); }
});
