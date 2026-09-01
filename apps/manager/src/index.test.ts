import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './core/db.ts';
import { NodeCatalog } from './core/nodes/catalog.ts';
import { PlatformPackageService } from './core/nodes/platform-package.ts';
import { NodeStore } from './core/nodes/store.ts';
import {
  VERSION,
  assembleInstanceAdminRuntime,
  assemblePlatformNodeServices,
  describe,
  startManagerRuntime,
} from './index.ts';
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

test('manager startup awaits network reconciliation then bootstrap recovery before serving', async () => {
  const events: string[] = [];
  const server = { name: 'server' };
  await startManagerRuntime({
    reconcileNetworks: async () => { events.push('network'); },
    recoverInterruptedBootstraps: async () => {
      events.push('recovery:start');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push('recovery:end');
    },
    startBackground: async () => { events.push('background'); },
    buildServer: async () => { events.push('build'); return server; },
    listen: async (built) => {
      assert.strictEqual(built, server);
      events.push('listen');
    },
  });
  assert.deepEqual(events, [
    'network', 'recovery:start', 'recovery:end', 'background', 'build', 'listen',
  ]);
});
