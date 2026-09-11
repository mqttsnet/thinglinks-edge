import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { HttpContext } from '../context.ts';
import type { NodeStore } from '../../core/nodes/store.ts';
import type { NodeCatalog } from '../../core/nodes/catalog.ts';
import { registerProtocols } from './catalog.ts';

test('protocol routes declare global and instance read permissions and never install', async () => {
  const permissions: unknown[] = [];
  let reads = 0;
  const app = Fastify();
  registerProtocols(app, {
    config: { basePath: '/edge' },
    guard: (_req: unknown, _reply: unknown, opts: unknown) => { permissions.push(opts); return { username: 'reader' }; },
    adminRuntime: { target: () => ({ upstream: 'http://unused', adminRoot: '/', username: '', password: '' }) },
  } as unknown as HttpContext, {
    store: { tarball: () => undefined } as unknown as NodeStore,
    catalog: { get: () => undefined } as unknown as NodeCatalog,
    readModules: async () => { reads += 1; return []; },
  });
  try {
    const catalog = await app.inject('/edge/api/protocols');
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().protocols.map((protocol: { id: string }) => protocol.id).sort(),
      ['tcp', 'udp', 'http', 'modbus-tcp', 'modbus-rtu', 'opcua', 'opcua-controlled', 's7', 'coap', 'bacnet', 'iec104'].sort());
    const tier0 = catalog.json().protocols.find((protocol: { id: string }) => protocol.id === 'opcua-controlled');
    assert.ok(tier0.requirements.some((requirement: { module: string; version: string }) =>
      requirement.module === '@tier0/opcua-client' && requirement.version === '0.6.0'));
    assert.equal(reads, 0);
    const instance = await app.inject('/edge/api/instances/line-a/protocols');
    assert.equal(instance.statusCode, 200);
    assert.equal(instance.json().inspected, true);
    assert.ok(instance.json().protocols.every((p: { ready: boolean }) => !p.ready));
    assert.deepEqual(permissions, [
      { csrf: false, need: 'node:view' },
      { csrf: false, need: 'instance:view', instance: 'line-a' },
    ]);
    assert.equal((await app.inject({ method: 'POST', url: '/edge/api/protocols' })).statusCode, 404);
  } finally { await app.close(); }
});

test('denied instance inspection cannot read runtime or cache', async () => {
  const app = Fastify();
  registerProtocols(app, {
    config: { basePath: '' }, guard: (_req: unknown, reply: { code: (n: number) => { send: (v: unknown) => void } }) => {
      reply.code(403).send({ error: 'forbidden' }); return undefined;
    },
  } as unknown as HttpContext, {
    store: { tarball: () => { throw new Error('must not read cache'); } } as unknown as NodeStore,
    catalog: { get: () => { throw new Error('must not read approval'); } } as unknown as NodeCatalog,
    readModules: async () => { throw new Error('must not inspect runtime'); },
  });
  try { assert.equal((await app.inject('/api/instances/line-b/protocols')).statusCode, 403); }
  finally { await app.close(); }
});

test('unavailable runtime exposes a controlled error and no false readiness', async () => {
  const app = Fastify();
  registerProtocols(app, {
    config: { basePath: '' }, guard: () => ({ username: 'reader' }),
    adminRuntime: { target: () => ({}) },
  } as unknown as HttpContext, {
    store: { tarball: () => undefined } as unknown as NodeStore,
    catalog: { get: () => undefined } as unknown as NodeCatalog,
    readModules: async () => { throw new Error('token=never-return'); },
  });
  try {
    const res = await app.inject('/api/instances/line-a/protocols');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().inspected, false);
    assert.doesNotMatch(res.body, /never-return/);
    assert.ok(res.json().protocols.every((p: {ready: boolean}) => !p.ready));
  } finally { await app.close(); }
});
