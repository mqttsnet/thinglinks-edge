import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './core/db.ts';
import { NodeCatalog } from './core/nodes/catalog.ts';
import { PlatformPackageService } from './core/nodes/platform-package.ts';
import { NodeStore } from './core/nodes/store.ts';
import { VERSION, assemblePlatformNodeServices, describe } from './index.ts';
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
