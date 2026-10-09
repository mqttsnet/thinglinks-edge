import { reactive, shallowRef } from 'vue';
import type { api } from '../../api/client';
import type { PlatformNodeMigration } from '../../api/types';

export type NodeSection = 'platform' | 'catalog' | 'store' | 'inventory' | 'sources';
export type NodePageApi = Pick<typeof api,
  'nodeCatalog' | 'nodeStore' | 'nodeInventory' | 'instances' | 'nodeSources' | 'platformNodeMigration'>;

/** Each request owns its data and status; unrelated endpoints never hold up its first render. */
export function createResource<T>(initial: T, fetch: () => Promise<T>, fallback: string) {
  const data = shallowRef(initial);
  const state = reactive({ loading: false, loaded: false, error: '', updatedAt: null as number | null });
  let generation = 0;
  let disposed = false;
  let pending: Promise<boolean> | undefined;
  function refresh(replace = false): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (pending && !replace) return pending;
    const ticket = ++generation;
    state.loading = true;
    state.error = '';
    const current = () => !disposed && ticket === generation;
    const request = (async () => {
      try {
        const next = await fetch();
        if (!current()) return false;
        data.value = next;
        state.loaded = true;
        state.updatedAt = Date.now();
        return true;
      } catch (error) {
        if (current()) state.error = `${fallback}${error instanceof Error ? `：${error.message}` : ''}`;
        return false;
      } finally {
        if (current()) state.loading = false;
      }
    })().finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  }
  return { data, state, refresh, dispose: () => { disposed = true; ++generation; } };
}

export function createNodePageData(api: NodePageApi) {
  const catalog = createResource<Awaited<ReturnType<NodePageApi['nodeCatalog']>>>(
    { entries: [] }, () => api.nodeCatalog(), '加载批准清单失败');
  const store = createResource<Awaited<ReturnType<NodePageApi['nodeStore']>>>(
    { packages: [], root: '' }, () => api.nodeStore(), '加载离线包库失败');
  const inventory = createResource<Awaited<ReturnType<NodePageApi['nodeInventory']>>>(
    { instances: [] }, () => api.nodeInventory(), '加载已装台账失败');
  const instances = createResource<Awaited<ReturnType<NodePageApi['instances']>>>(
    { instances: [] }, () => api.instances(), '加载实例清单失败');
  const sources = createResource<Awaited<ReturnType<NodePageApi['nodeSources']>>>(
    { sources: [] }, () => api.nodeSources(), '加载节点源失败');
  type MigrationData = { statuses: Record<string, PlatformNodeMigration>; errors: Record<string, string> };
  const migrations = createResource<MigrationData>({ statuses: {}, errors: {} }, async () => {
    // loadSection starts instances first, so this shares that request instead of querying twice.
    if (!await instances.refresh()) throw new Error('实例清单读取失败，迁移状态未更新');
    const current = instances.data.value.instances;
    const results = await Promise.allSettled(current.map((item) => api.platformNodeMigration(item.id)));
    const next: MigrationData = { statuses: {}, errors: {} };
    results.forEach((result, index) => {
      const id = current[index]!.id;
      if (result.status === 'fulfilled') next.statuses[id] = result.value;
      else {
        const previous = migrations.data.value.statuses[id];
        if (previous) next.statuses[id] = previous;
        next.errors[id] = result.reason instanceof Error ? result.reason.message : '迁移状态读取失败';
      }
    });
    return next;
  }, '加载迁移状态失败');
  const dependencies = {
    catalog: [catalog], store: [store], sources: [sources],
    inventory: [instances, inventory], platform: [instances, catalog, store, inventory, migrations],
  };
  const lastSuccess = reactive<Record<NodeSection, number | null>>({
    catalog: null, store: null, inventory: null, platform: null, sources: null,
  });
  const sectionGeneration = new Map<NodeSection, number>();
  const pendingSections = new Map<NodeSection, Promise<boolean[]>>();
  let disposed = false;
  function loadSection(section: NodeSection, replace = false): Promise<boolean[]> {
    if (disposed) return Promise.resolve([]);
    const pending = pendingSections.get(section);
    if (pending && !replace) return pending;
    const ticket = (sectionGeneration.get(section) ?? 0) + 1;
    sectionGeneration.set(section, ticket);
    const request = Promise.all(dependencies[section].map((resource) => resource.refresh(replace)))
      .then((results) => {
        if (!disposed && sectionGeneration.get(section) === ticket && status(section).ready) {
          lastSuccess[section] = Math.min(...dependencies[section].map((r) => r.state.updatedAt!));
        }
        return results;
      }).finally(() => { if (pendingSections.get(section) === request) pendingSections.delete(section); });
    pendingSections.set(section, request);
    return request;
  }
  function status(section: NodeSection) {
    const resources = dependencies[section];
    const errors = resources.map((r) => r.state.error).filter(Boolean);
    if (section === 'platform' && Object.keys(migrations.data.value.errors).length) {
      errors.push('部分实例迁移状态读取失败，详见对应实例');
    }
    const loaded = resources.every((r) => r.state.loaded);
    const loading = resources.some((r) => r.state.loading);
    return {
      loading, loaded, error: errors.join('；'),
      ready: loaded && !loading && errors.length === 0,
      updatedAt: resources.length === 1 ? resources[0]!.state.updatedAt : lastSuccess[section],
    };
  }
  function inventoryEvidence(instanceId: string) {
    if (inventory.state.loading) return { available: false, reason: '正在读取实例台账' };
    if (inventory.state.error) return { available: false, reason: inventory.state.error };
    if (!inventory.state.loaded) return { available: false, reason: '实例台账尚待读取确认' };
    const item = inventory.data.value.instances.find((entry) => entry.instanceId === instanceId);
    if (!item) return { available: false, reason: '本次台账未返回该实例，安装与健康状态未知' };
    if (!item.ok) return { available: false, reason: `实例台账读取失败：${item.reason || '原因未提供'}，安装与健康状态未知` };
    return { available: true, reason: '' };
  }
  function migrationReady(instanceId: string) {
    return dependencies.platform.every((r) => r.state.loaded && !r.state.loading && !r.state.error)
      && !!migrations.data.value.statuses[instanceId] && !migrations.data.value.errors[instanceId];
  }
  return {
    catalog, store, inventory, instances, sources, migrations, loadSection, status, migrationReady, inventoryEvidence,
    dispose: () => {
      disposed = true;
      for (const resource of dependencies.platform) resource.dispose();
      sources.dispose();
    },
  };
}
