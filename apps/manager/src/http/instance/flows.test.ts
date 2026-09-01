import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import { InstanceOperationGate, InstanceBusyError } from '../../core/instance/operation-gate.ts';
import { InstanceRepo, type InstanceRecord } from '../../core/instance/repo.ts';
import type { HttpContext } from '../context.ts';
import { registerFlows } from './flows.ts';

const instance: InstanceRecord = {
  id: 'line-a',
  name: 'line-a',
  imageTag: '5.0.4-24-minimal',
  memLimit: 512,
  cpuLimit: 0.5,
  adminRoot: '/red/line-a/',
  credSecret: 'credential-secret',
  notes: '',
};

test('whole-flow POST uses the shared gate before any Admin API or audit side effect', async () => {
  let adminCalls = 0;
  const upstream = createServer((req, res) => {
    adminCalls += 1;
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"token"}');
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/flows')) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');

  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('flows-gate-test', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  const operationGate = new InstanceOperationGate({ assertAllowed: () => undefined });
  const app = Fastify({ logger: false });
  registerFlows(app, {
    config: { basePath: '' },
    db,
    repo,
    operationGate,
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
    guard: () => ({ username: 'admin', role: 'admin' }),
    fail: (reply, error) => reply
      .code(error instanceof InstanceBusyError ? 409 : 400)
      .send({ error: (error as Error).message }),
  } as unknown as HttpContext);

  try {
    const beforeAudit = (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    await operationGate.run('line-a', 'platform-migration', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/instances/line-a/flows',
        payload: { flows: [] },
      });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /platform-migration/);
    });
    assert.equal(adminCalls, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
