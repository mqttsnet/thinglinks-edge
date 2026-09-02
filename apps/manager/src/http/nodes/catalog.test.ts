import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import {
  InstanceOperationGate,
  InstanceBusyError,
  InstanceRepositoryOperationPolicy,
} from '../../core/instance/operation-gate.ts';
import { InstanceRepo, type InstanceRecord } from '../../core/instance/repo.ts';
import { NodeCatalog } from '../../core/nodes/catalog.ts';
import { NodeStore } from '../../core/nodes/store.ts';
import { PLATFORM_NODE_PACKAGE } from '../../core/nodes/platform-contract.ts';
import { PlatformMigrationError, type PlatformMigrationResult, type PlatformMigrationService } from '../../core/nodes/platform-migration.ts';
import type { HttpContext } from '../context.ts';
import { registerNodeCatalog } from './catalog.ts';

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

test('install-node POST honors live and repository-backed gates before side effects', async () => {
  let adminCalls = 0;
  const upstream = createServer((req, res) => {
    adminCalls += 1;
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"token"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');

  const root = mkdtempSync(join(tmpdir(), 'tle-node-gate-'));
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('catalog-gate-test', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  const operationGate = new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo));
  const app = Fastify({ logger: false });
  registerNodeCatalog(app, {
    config: { basePath: '' },
    db,
    repo,
    operationGate,
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
    guard: () => ({ username: 'admin', role: 'admin' }),
    visibleOnly: (_user, items) => items,
    fail: (reply, error) => reply
      .code(error instanceof InstanceBusyError ? 409 : 400)
      .send({ error: (error as Error).message }),
  } as unknown as HttpContext, {
    store: new NodeStore(root),
    catalog: new NodeCatalog(db),
  });

  try {
    const beforeAudit = (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    await operationGate.run('line-a', 'platform-migration', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/instances/line-a/nodes',
        payload: { module: 'node-red-contrib-example', version: '1.0.0' },
      });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /platform-migration/);
    });
    repo.beginNodeMigration({
      instanceId: 'line-a',
      txId: 'tx-install-manual',
      operationKind: 'bootstrap',
      phase: 'preparing',
      originalRunning: false,
      stagedBefore: false,
      modeBefore: 'legacy',
      imageIdBefore: 'sha256:image-a',
      targetIntegrity: PLATFORM_NODE_PACKAGE.integrity,
      checkpointDir: '',
      snapshot: { version: 1, kind: 'bootstrap' },
      actor: 'admin',
    });
    repo.updateNodeMigration('line-a', 'manual_required', 'state-inconsistent');
    const persisted = await app.inject({
      method: 'POST',
      url: '/api/instances/line-a/nodes',
      payload: { module: 'node-red-contrib-example', version: '1.0.0' },
    });
    assert.equal(persisted.statusCode, 409);
    assert.match(persisted.json().error, /manual_required\/state-inconsistent/);
    assert.equal(adminCalls, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform migration endpoints declare instance permissions, CSRF, and expose only safe status fields', async () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'tle-node-migration-http-'));
  const app = Fastify({ logger: false });
  const guarded: Array<{ csrf: boolean; need: string; instance?: string }> = [];
  const calls: Array<{ method: 'status' | 'migrate'; id: string; actor?: string }> = [];
  const status: PlatformMigrationResult = {
    instanceId: 'line-a', phase: 'manual_required', runtimeMode: 'legacy',
    platformVersion: '', error: 'state-inconsistent',
  };
  const migrationService = {
    status(id: string) {
      calls.push({ method: 'status', id });
      return status;
    },
    async migrate(id: string, actor: string) {
      calls.push({ method: 'migrate', id, actor });
      return {
        ...status,
        phase: 'rolled_back_dirty' as const,
        error: 'rollback' as const,
      };
    },
  } as unknown as PlatformMigrationService;
  registerNodeCatalog(app, {
    config: { basePath: '' }, db,
    guard: (_req, _reply, opts) => {
      guarded.push(opts);
      return { username: 'operator', role: 'admin' };
    },
    fail: (reply, error) => reply.code(400).send({ error: (error as Error).message }),
  } as unknown as HttpContext, {
    store: new NodeStore(root), catalog: new NodeCatalog(db), migrationService,
  });

  try {
    const read = await app.inject({
      method: 'GET', url: '/api/instances/line-a/nodes/thinglinks-migration',
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), status);
    assert.deepEqual(guarded.pop(), { csrf: false, need: 'instance:view', instance: 'line-a' });

    const write = await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
    });
    assert.equal(write.statusCode, 200);
    assert.deepEqual(write.json(), {
      ...status, phase: 'rolled_back_dirty', error: 'rollback',
    });
    assert.deepEqual(guarded.pop(), { csrf: true, need: 'instance:operate', instance: 'line-a' });
    assert.deepEqual(calls, [
      { method: 'status', id: 'line-a' },
      { method: 'migrate', id: 'line-a', actor: 'operator' },
    ]);

    const catalogRead = await app.inject({ method: 'GET', url: '/api/nodes/catalog' });
    assert.equal(catalogRead.statusCode, 200);
    assert.deepEqual(calls, [
      { method: 'status', id: 'line-a' },
      { method: 'migrate', id: 'line-a', actor: 'operator' },
    ], 'catalogue reads never start or inspect migration');

    const invalid = await app.inject({
      method: 'POST', url: '/api/instances/INVALID/nodes/thinglinks-migration',
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: '实例 ID 非法' });
    assert.deepEqual(calls, [
      { method: 'status', id: 'line-a' },
      { method: 'migrate', id: 'line-a', actor: 'operator' },
    ]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform migration POST maps controlled failures without leaking the underlying error', async () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'tle-node-migration-safe-error-'));
  const app = Fastify({ logger: false });
  const migrationService = {
    status: () => ({
      instanceId: 'line-a', phase: 'idle', runtimeMode: 'legacy', platformVersion: '', error: 'none',
    }),
    migrate: async () => {
      throw new PlatformMigrationError('preflight', 'sensitive-value /private/checkpoint');
    },
  } as unknown as PlatformMigrationService;
  registerNodeCatalog(app, {
    config: { basePath: '' }, db,
    guard: () => ({ username: 'operator', role: 'admin' }),
    fail: (reply, error) => reply.code(400).send({ error: (error as Error).message }),
  } as unknown as HttpContext, {
    store: new NodeStore(root), catalog: new NodeCatalog(db), migrationService,
  });

  try {
    const response = await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: '迁移预检未通过，请检查实例状态后重试', code: 'preflight' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
