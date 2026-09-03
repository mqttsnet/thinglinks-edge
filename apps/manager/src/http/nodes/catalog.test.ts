import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { openDb } from '../../core/db.ts';
import { deriveKey } from '../../core/auth/crypto.ts';
import { AuthService } from '../../core/auth/service.ts';
import { UserRepo } from '../../core/auth/user-repo.ts';
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
import { createContext, type HttpContext, type ServerDeps } from '../context.ts';
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
    migrationService: {} as PlatformMigrationService,
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

test('inventory response preserves Manager-observed source, health, and deterministic type conflicts', async () => {
  const upstream = createServer((req, res) => {
    if (req.url?.endsWith('/auth/token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"test"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'raw', module: 'node-red', version: '5.0.4', types: ['tl-device'], enabled: true },
      {
        id: 'npm', module: '@mqttsnet/thinglinks-edge-nodes', version: '0.0.1',
        types: ['tl-device'], enabled: true, local: true,
      },
    ]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const root = mkdtempSync(join(tmpdir(), 'tle-node-inventory-response-'));
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, deriveKey('catalog-inventory-response', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  const app = Fastify({ logger: false });
  registerNodeCatalog(app, {
    config: { basePath: '' }, db, repo,
    operationGate: new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo)),
    adminRuntime: { target: () => ({
      upstream: `http://127.0.0.1:${address.port}`,
      adminRoot: instance.adminRoot,
      username: 'admin', password: 'secret',
    }) },
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
    guard: () => ({ username: 'admin', role: 'admin' }),
    visibleOnly: (_user, items) => items,
    fail: (reply, error) => reply.code(400).send({ error: (error as Error).message }),
  } as unknown as HttpContext, {
    store: new NodeStore(root), catalog: new NodeCatalog(db),
    migrationService: {} as PlatformMigrationService,
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/api/nodes/inventory' });
    assert.equal(response.statusCode, 200);
    const result = response.json().instances[0] as {
      health?: string;
      conflicts?: Array<{ type: string; owners: string[] }>;
      modules: Array<{ module: string; source?: string; health?: string }>;
    };
    assert.equal(result.health, 'conflict');
    assert.deepEqual(result.conflicts, [{
      type: 'tl-device', owners: ['@mqttsnet/thinglinks-edge-nodes', 'node-red'],
    }]);
    assert.deepEqual(result.modules.map((module) => [module.module, module.source, module.health]), [
      ['@mqttsnet/thinglinks-edge-nodes', 'npm', 'conflict'],
      ['node-red', 'raw', 'conflict'],
    ]);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration routes enforce real session grants and CSRF without route-side operational effects', async () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'tle-node-migration-auth-'));
  const auth = new AuthService(db);
  auth.createFirstAdmin('admin', 'an-admin-password');
  const users = new UserRepo(db);
  const viewerPassword = users.create('viewer', 'viewer', 'admin');
  const operatorPassword = users.create('operator', 'operator', 'admin');
  const viewerReadyPassword = 'viewer-ready-password';
  const operatorReadyPassword = 'operator-ready-password';
  auth.changePassword('viewer', viewerPassword, viewerReadyPassword);
  auth.changePassword('operator', operatorPassword, operatorReadyPassword);
  const repo = new InstanceRepo(db, deriveKey('catalog-migration-auth', 'instance'));
  repo.create(instance, [], [{ username: 'admin', password: 'secret', permissions: '*' }]);
  users.grant('viewer', 'line-a', 'view', 'admin');
  users.grant('operator', 'line-a', 'operate', 'admin');
  let migrateCalls = 0;
  const active: PlatformMigrationResult = {
    instanceId: 'line-a', phase: 'preparing', runtimeMode: 'legacy', platformVersion: '', error: 'none',
  };
  const migrationService = {
    status: () => active,
    migrate: async () => { migrateCalls += 1; return active; },
  } as unknown as PlatformMigrationService;
  const app = Fastify({ logger: false });
  await app.register(cookie);
  const context = createContext({
    config: { basePath: '', cookieSecure: false },
    db, auth, repo,
    service: {}, adminRuntime: {},
    operationGate: new InstanceOperationGate(new InstanceRepositoryOperationPolicy(repo)),
    migrationService, proxySessions: {}, platformPackages: {},
  } as unknown as ServerDeps);
  registerNodeCatalog(app, context, {
    store: new NodeStore(root), catalog: new NodeCatalog(db), migrationService,
  });
  await app.ready();
  const viewerSid = auth.login('viewer', viewerReadyPassword).sid;
  const operatorSid = auth.login('operator', operatorReadyPassword).sid;
  const cookieFor = (sid: string, csrf = 'valid-csrf') => `tle_sid=${sid}; tle_csrf=${csrf}`;

  try {
    const beforeAudit = (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
    assert.equal((await app.inject({
      method: 'GET', url: '/api/instances/line-a/nodes/thinglinks-migration',
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'GET', url: '/api/instances/line-b/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(viewerSid) },
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: 'GET', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(viewerSid) },
    })).statusCode, 200, 'GET needs view but not CSRF');
    assert.equal((await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(viewerSid), 'x-csrf-token': 'valid-csrf' },
    })).statusCode, 403, 'view grant does not imply operate');
    assert.equal((await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(operatorSid) },
    })).statusCode, 403, 'POST requires CSRF');
    assert.equal((await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(operatorSid), 'x-csrf-token': 'wrong-csrf' },
    })).statusCode, 403, 'POST rejects mismatched CSRF');

    const first = await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(operatorSid), 'x-csrf-token': 'valid-csrf' },
    });
    const second = await app.inject({
      method: 'POST', url: '/api/instances/line-a/nodes/thinglinks-migration',
      headers: { cookie: cookieFor(operatorSid), 'x-csrf-token': 'valid-csrf' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(first.json(), active);
    assert.deepEqual(second.json(), active, 'active transaction status is service authority');
    assert.equal(migrateCalls, 2, 'route delegates each explicit request without creating a second service');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n,
      beforeAudit,
      'migration service, not the route, owns operation audits',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
