import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePageData, createResource } from './node-page-data.ts';
import type { NodePageApi } from './node-page-data.ts';
import type { Instance, PlatformNodeMigration } from '../../api/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<NodePageApi> = {}) {
  const calls: string[] = [];
  const api: NodePageApi = {
    nodeCatalog: async () => { calls.push('catalog'); return { entries: [] }; },
    nodeStore: async () => { calls.push('store'); return { packages: [], root: '/store' }; },
    nodeInventory: async () => { calls.push('inventory'); return { instances: [] }; },
    instances: async () => { calls.push('instances'); return { instances: [] }; },
    nodeSources: async () => { calls.push('sources'); return { sources: [] }; },
    platformNodeMigration: async () => { calls.push('migration'); return { phase: 'idle' } as PlatformNodeMigration; },
    ...overrides,
  };
  return { page: createNodePageData(api), calls };
}

test('opening and refreshing the approval tab only requests its own data', async () => {
  const { page, calls } = fixture();
  await page.loadSection('catalog');
  assert.deepEqual(calls, ['catalog']);
  assert.equal(page.status('catalog').ready, true);
  await page.loadSection('catalog');
  assert.deepEqual(calls, ['catalog', 'catalog']);
});

test('a slow inventory request never delays approval data or tab status', async () => {
  const pending = deferred<{ instances: [] }>();
  const { page } = fixture({ nodeInventory: () => pending.promise });
  const inventory = page.loadSection('inventory');
  await page.loadSection('catalog');
  assert.equal(page.status('catalog').ready, true);
  assert.equal(page.status('catalog').loading, false);
  assert.equal(page.status('inventory').loading, true);
  pending.resolve({ instances: [] });
  await inventory;
});

test('deduplicates in-flight refresh, preserves successful data on failure, and retries', async () => {
  const first = deferred<string[]>();
  let calls = 0;
  let fetch = () => first.promise;
  const resource = createResource<string[]>([], () => { ++calls; return fetch(); }, '读取失败');
  const one = resource.refresh();
  assert.equal(resource.state.loaded, false);
  assert.equal(resource.refresh(), one);
  assert.equal(calls, 1);
  first.resolve(['kept']);
  await one;
  const updatedAt = resource.state.updatedAt;
  fetch = async () => { throw new Error('unavailable'); };
  const failing = resource.refresh(true);
  await failing;
  assert.deepEqual(resource.data.value, ['kept']);
  assert.equal(resource.state.updatedAt, updatedAt);
  assert.equal(resource.state.loaded, true);
  assert.match(resource.state.error, /unavailable/);
  fetch = async () => ['new'];
  await resource.refresh(true);
  assert.deepEqual(resource.data.value, ['new']);
  assert.equal(resource.state.error, '');
});

test('post-mutation refresh supersedes stale reads and disposal ignores late responses', async () => {
  const pending = deferred<string[]>();
  let fetch = () => pending.promise;
  const resource = createResource<string[]>([], () => fetch(), '读取失败');
  const old = resource.refresh();
  fetch = async () => ['after mutation'];
  await resource.refresh(true);
  pending.resolve(['old']);
  await old;
  assert.deepEqual(resource.data.value, ['after mutation']);
  const late = deferred<string[]>();
  fetch = () => late.promise;
  const next = resource.refresh(true);
  resource.dispose();
  late.resolve(['after unmount']);
  await next;
  assert.deepEqual(resource.data.value, ['after mutation']);
});

test('platform readiness includes all five dependencies and partial migration errors', async () => {
  const pending = deferred<{ instances: [] }>();
  const { page } = fixture({
    instances: async () => ({ instances: [{ id: 'line-a' }, { id: 'line-b' }] as Instance[] }),
    nodeInventory: () => pending.promise,
    platformNodeMigration: async (id) => {
      if (id === 'line-b') throw new Error('instance unavailable');
      return { phase: 'idle' } as PlatformNodeMigration;
    },
  });
  const loading = page.loadSection('platform');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(page.catalog.state.loaded, true);
  assert.equal(page.status('platform').ready, false);
  assert.equal(page.status('platform').loading, true);
  pending.resolve({ instances: [] });
  await loading;
  assert.equal(page.status('platform').ready, false);
  assert.match(page.status('platform').error, /迁移状态/);
  assert.equal(page.migrations.data.value.statuses['line-a']?.phase, 'idle');
  assert.equal(page.migrationReady('line-a'), true);
  assert.equal(page.migrationReady('line-b'), false);
  assert.match(page.migrations.data.value.errors['line-b']!, /unavailable/);
});

test('platform retains previous migration evidence but marks failed reads as stale', async () => {
  let fail = false;
  const { page } = fixture({
    instances: async () => ({ instances: [{ id: 'line-a' }] as Instance[] }),
    platformNodeMigration: async () => {
      if (fail) throw new Error('unavailable');
      return { phase: 'committed' } as PlatformNodeMigration;
    },
  });
  await page.loadSection('platform');
  assert.equal(page.status('platform').ready, true);
  const lastSuccess = page.status('platform').updatedAt;
  assert.ok(lastSuccess);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  fail = true;
  await page.loadSection('platform');
  assert.equal(page.status('platform').ready, false);
  assert.equal(page.migrations.data.value.statuses['line-a']?.phase, 'committed');
  assert.match(page.migrations.data.value.errors['line-a']!, /unavailable/);
  assert.equal(page.status('platform').updatedAt, lastSuccess);
});

test('failed instance listing does not query stale instance ids for migration', async () => {
  const { page, calls } = fixture({ instances: async () => { throw new Error('Docker unavailable'); } });
  await page.loadSection('platform');
  assert.equal(page.status('platform').ready, false);
  assert.equal(calls.includes('migration'), false);
  assert.match(page.status('platform').error, /实例/);
});


test('store, sources and inventory refresh only their required dependencies', async () => {
  const { page, calls } = fixture();
  await page.loadSection('store');
  assert.deepEqual(calls.splice(0), ['store']);
  await page.loadSection('sources');
  assert.deepEqual(calls.splice(0), ['sources']);
  await page.loadSection('inventory');
  assert.deepEqual(calls.splice(0), ['instances', 'inventory']);
});

test('re-entering a still-loading platform section shares the complete refresh', async () => {
  const migration = deferred<PlatformNodeMigration>();
  let instanceReads = 0;
  let migrationReads = 0;
  const { page } = fixture({
    instances: async () => { ++instanceReads; return { instances: [{ id: 'line-a' }] as Instance[] }; },
    platformNodeMigration: () => { ++migrationReads; return migration.promise; },
  });
  const first = page.loadSection('platform');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await page.loadSection('catalog');
  assert.equal(page.status('catalog').ready, true);
  assert.equal(page.status('platform').ready, false);
  assert.equal(page.loadSection('platform'), first);
  assert.equal(instanceReads, 1);
  assert.equal(migrationReads, 1);
  migration.resolve({ phase: 'idle' } as PlatformNodeMigration);
  await first;
  assert.equal(page.status('platform').ready, true);
});

test('single-resource tabs use the successful refresh time after direct mutation reloads', async () => {
  const { page } = fixture();
  for (const section of ['catalog', 'store', 'sources'] as const) {
    await page.loadSection(section);
    const before = page.status(section).updatedAt;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await page[section].refresh(true);
    assert.equal(page.status(section).updatedAt, page[section].state.updatedAt);
    assert.ok(page.status(section).updatedAt! > before!);
  }
});

test('failed, omitted or stale instance inventory never supplies installation or health evidence', async () => {
  let fail = false;
  const { page } = fixture({ nodeInventory: async () => {
    if (fail) throw new Error('request failed');
    return { instances: [
    { instanceId: 'failed', ok: false, reason: 'connection timeout', unapproved: 0, modules: [] },
    { instanceId: 'healthy', ok: true, reason: '', unapproved: 0, modules: [] },
  ] }; } });
  assert.equal(page.inventoryEvidence('healthy').available, false);
  await page.loadSection('inventory');
  assert.equal(page.inventoryEvidence('healthy').available, true);
  assert.equal(page.inventoryEvidence('failed').available, false);
  assert.match(page.inventoryEvidence('failed').reason, /connection timeout/);
  assert.equal(page.inventoryEvidence('missing').available, false);
  assert.match(page.inventoryEvidence('missing').reason, /未返回/);
  fail = true;
  await page.inventory.refresh();
  assert.equal(page.inventoryEvidence('healthy').available, false);
});
