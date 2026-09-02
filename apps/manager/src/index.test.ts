import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './core/db.ts';
import { NodeCatalog } from './core/nodes/catalog.ts';
import { PlatformPackageService } from './core/nodes/platform-package.ts';
import { NodeStore } from './core/nodes/store.ts';
import {
  VERSION,
  assembleInstanceAdminRuntime,
  assemblePlatformOperationBarrier,
  assemblePlatformNodeServices,
  describe,
  startManagerRuntime,
} from './index.ts';
import { NOOP_PLATFORM_NODE_BARRIER } from './core/nodes/platform-operation-barrier.ts';
import { InstanceRepo } from './core/instance/repo.ts';
import { deriveKey } from './core/auth/crypto.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('版本号形如 x.y.z', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('describe 含产品名与版本', () => {
  const s = describe();
  assert.ok(s.includes('ThingLinks Edge Manager'));
  assert.ok(s.includes(VERSION));
});

test('平台包装配只 bootstrap 一个服务并把同一引用交给 server 与 registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'tle-platform-composition-'));
  const original = PlatformPackageService.prototype.bootstrap;
  let bootstraps = 0;
  PlatformPackageService.prototype.bootstrap = function bootstrap(actor = 'system') {
    bootstraps += 1;
    assert.equal(actor, 'system');
    return {} as ReturnType<PlatformPackageService['bootstrap']>;
  };
  try {
    const assembled = assemblePlatformNodeServices({
      store: new NodeStore(join(root, 'npm')),
      catalog: new NodeCatalog(openDb(':memory:')),
    });
    assert.equal(bootstraps, 1);
    assert.ok(assembled.platformPackages instanceof PlatformPackageService);
    assert.strictEqual(assembled.serverDeps.platformPackages, assembled.platformPackages);
    assert.strictEqual(assembled.registryDeps.platformPackages, assembled.platformPackages);
  } finally {
    PlatformPackageService.prototype.bootstrap = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Admin runtime composition shares one object with InstanceService and HttpContext deps', () => {
  const repo = new InstanceRepo(openDb(':memory:'), deriveKey('index-admin-runtime', 'instance'));
  const assembled = assembleInstanceAdminRuntime({
    repo,
    upstreamFor: (id) => `http://instance-${id}:1880`,
  });
  assert.strictEqual(assembled.instanceServiceDeps.adminRuntime, assembled.adminRuntime);
  assert.strictEqual(assembled.serverDeps.adminRuntime, assembled.adminRuntime);
});

test('manager startup orders data, trust, singleton construction, network, unified recovery, backgrounds, and serving', async () => {
  const events: string[] = [];
  const server = { name: 'server' };
  const context = { marker: 'typed-local-context', phase: 0 };
  await startManagerRuntime({
    initializeData: async () => { events.push('data'); return context; },
    bootstrapTrust: async (received) => {
      assert.strictEqual(received, context);
      received.phase += 1;
      events.push('trust');
    },
    constructServices: async (received) => {
      assert.strictEqual(received, context);
      assert.equal(received.phase, 1);
      received.phase += 1;
      events.push('construct');
    },
    reconcileNetworks: async (received) => {
      assert.strictEqual(received, context);
      assert.equal(received.phase, 2);
      events.push('network');
    },
    recoverInterrupted: async (received) => {
      assert.strictEqual(received, context);
      events.push('recovery:start');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push('recovery:end');
    },
    startBackground: async (received) => {
      assert.strictEqual(received, context);
      events.push('background');
    },
    buildServer: async (received) => {
      assert.strictEqual(received, context);
      events.push('build');
      return {
        server,
        listen: async () => { events.push('listen'); },
      };
    },
  });
  assert.deepEqual(events, [
    'data', 'trust', 'construct', 'network',
    'recovery:start', 'recovery:end', 'background', 'build', 'listen',
  ]);
});

test('startup phase failure prevents every later phase and listener', async () => {
  const events: string[] = [];
  await assert.rejects(
    () => startManagerRuntime({
      initializeData: async () => { events.push('data'); return { ready: true }; },
      bootstrapTrust: async (context) => {
        assert.equal(context.ready, true);
        events.push('trust');
        throw new Error('trust failed');
      },
      constructServices: async () => { events.push('construct'); },
      reconcileNetworks: async () => { events.push('network'); },
      recoverInterrupted: async () => { events.push('recovery'); },
      startBackground: async () => { events.push('background'); },
      buildServer: async () => ({
        server: {},
        listen: async () => { events.push('listen'); },
      }),
    }),
    /trust failed/,
  );
  assert.deepEqual(events, ['data', 'trust']);
});

test('the object-only barrier seam is shared by creation and migration while production is NOOP', async () => {
  const events: string[] = [];
  const barrier = { reach: async () => { events.push('reached'); } };
  const verifier = assemblePlatformOperationBarrier({ barrier });
  assert.strictEqual(verifier.barrier, barrier);
  assert.strictEqual(verifier.instanceServiceDeps.barrier, barrier);
  assert.strictEqual(verifier.migrationServiceDeps.barrier, barrier);
  await verifier.instanceServiceDeps.barrier.reach({
    instanceId: 'line-a', txId: 'tx-01', phase: 'preparing', sequence: 1,
    boundary: 'after-phase-persist',
  });
  assert.deepEqual(events, ['reached']);

  process.env['TLE_PLATFORM_NODE_BARRIER'] = 'pause';
  try {
    assert.strictEqual(assemblePlatformOperationBarrier().barrier, NOOP_PLATFORM_NODE_BARRIER);
  } finally {
    delete process.env['TLE_PLATFORM_NODE_BARRIER'];
  }
  assert.throws(
    () => assemblePlatformOperationBarrier({
      barrier,
      hiddenSwitch: true,
    } as never),
    /unsupported internal Manager override/,
  );
});
