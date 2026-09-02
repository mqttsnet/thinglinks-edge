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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await startManagerRuntime({
    initializeData: async () => { events.push('data'); },
    bootstrapTrust: async () => { events.push('trust'); },
    constructServices: async () => { events.push('construct'); },
    reconcileNetworks: async () => { events.push('network'); },
    recoverInterrupted: async () => {
      events.push('recovery:start');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push('recovery:end');
    },
    startBackground: async () => { events.push('background'); },
    buildServer: async () => {
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

test('production composition establishes seed and trust before gate Docker migration and recovery', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
  const mainSource = source.slice(source.indexOf('export async function main'));
  const positions = [
    'seedFromDir(nodeStore, seedDir)',
    'assemblePlatformNodeServices({',
    'new InstanceOperationGate(',
    'new DockerClient({',
    'new PlatformMigrationService({',
    'reconcileNetworks,',
    'recoverInterrupted: async () =>',
    'startBackground: async () =>',
    'buildServer: () =>',
  ].map((needle) => {
    const index = mainSource.indexOf(needle);
    assert.ok(index >= 0, needle);
    return index;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});
