/**
 * 平台侧节点台账（01 号文 5.7「平台侧可查看各实例已安装的节点清单」）。
 *
 * Node-RED Admin API 是运行时加载状态的证据，不是文件系统审计接口：`file` 缺失
 * 合法，出现时也只作为观察值。npm 的 package.json、lockfile、node_modules 归属
 * 证明由迁移验证器另行检查，不能在这里从路径猜出来。
 */
import {
  getInstalledNodeSets,
  moduleFromNodeSets,
  AdminApiError,
  type AdminTarget,
  type FetchLike,
  type InstalledModule,
  type InstalledNodeSet,
} from '../flows/admin-client.ts';
import { PLATFORM_NODE_PACKAGE, PLATFORM_NODE_TYPES } from './platform-contract.ts';

/** 一条节点在合规意义上的判定。 */
export type NodeCompliance = 'builtin' | 'platform' | 'approved' | 'unapproved';

export interface InventoryItem extends InstalledModule {
  compliance: NodeCompliance;
}

export interface InstalledInventory {
  modules: InstalledModule[];
  /** failed 优先于 conflict：先处理加载失败，冲突列表仍完整保留供修复后复查。 */
  health: 'healthy' | 'conflict' | 'failed';
  conflicts: Array<{ type: string; owners: string[] }>;
}

export interface InstanceInventory {
  instanceId: string;
  /** 读取成功与否。失败时 modules 为空，reason 说明原因。 */
  ok: boolean;
  reason: string;
  modules: InventoryItem[];
  /** 不在批准清单内的模块数，界面上直接用它标红。 */
  unapproved: number;
}

const PLATFORM_TYPES = new Set<string>(PLATFORM_NODE_TYPES);

/**
 * 从 Node-RED 原始 node set 得到全局台账。
 *
 * 同一模块的加载错误永远留在 module.errors/nodeSets 中，并让其 health=failed。
 * 重复类型按不同 module 的完整 owner 列表呈现；若两种问题同时存在，failed 是
 * 全局 health 的优先状态，但 conflicts 不会被隐藏。
 */
export function aggregateNodeSets(nodeSets: InstalledNodeSet[]): InstalledInventory {
  const byModule = new Map<string, InstalledNodeSet[]>();
  for (const nodeSet of nodeSets) {
    if (!nodeSet.module) continue;
    const current = byModule.get(nodeSet.module) ?? [];
    current.push(nodeSet);
    byModule.set(nodeSet.module, current);
  }

  const modules = [...byModule.entries()]
    .map(([module, sets]) => moduleFromNodeSets(module, sets))
    .sort((a, b) => a.module.localeCompare(b.module));

  const ownersByType = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const type of module.types) {
      const owners = ownersByType.get(type) ?? new Set<string>();
      owners.add(module.module);
      ownersByType.set(type, owners);
    }
  }
  const conflicts = [...ownersByType.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([type, owners]) => ({ type, owners: [...owners].sort() }))
    .sort((a, b) => a.type.localeCompare(b.type));
  const conflictedOwners = new Set(conflicts.flatMap((conflict) => conflict.owners));
  const assessed = modules.map((module) => ({
    ...module,
    // A real node-set load error is more important than duplicate ownership evidence.
    health: module.health === 'failed' || module.errors.length > 0 ? 'failed' as const
      : conflictedOwners.has(module.module) ? 'conflict' as const : 'healthy' as const,
  }));
  const health = assessed.some((module) => module.health === 'failed') ? 'failed'
    : conflicts.length > 0 ? 'conflict' : 'healthy';
  return { modules: assessed, health, conflicts };
}

/**
 * 可识别的 raw 平台节点只限 node-red 模块中那三个精确类型；发布包也必须名称和
 * 版本都精确命中。不能因为 scope 相同、file 看起来像 node_modules 就提升信任级别。
 */
export function classify(m: InstalledModule, approved: ReadonlySet<string>): NodeCompliance {
  if (m.module === 'node-red') {
    const hasPlatformType = m.types.some((type) => PLATFORM_TYPES.has(type));
    const hasBuiltinType = m.types.some((type) => !PLATFORM_TYPES.has(type));
    if (!hasPlatformType || hasBuiltinType) return 'builtin';
    return 'platform';
  }
  if (
    m.module === PLATFORM_NODE_PACKAGE.name
    && m.version === PLATFORM_NODE_PACKAGE.version
    && m.observedVersions.length === 1
    && m.observedVersions[0] === PLATFORM_NODE_PACKAGE.version
    && m.nodeSets.length > 0
    && m.nodeSets.every((nodeSet) => (
      nodeSet.module === PLATFORM_NODE_PACKAGE.name
      && nodeSet.version === PLATFORM_NODE_PACKAGE.version
    ))
  ) {
    return 'platform';
  }
  return approved.has(m.module) ? 'approved' : 'unapproved';
}

/** 发布的 Edge 包的加载验收，不接受缺项、重复、额外类型或任何 node-set 错误。 */
export function assertHealthyPlatformModule(installed: InstalledModule): void {
  if (installed.module !== PLATFORM_NODE_PACKAGE.name) {
    throw new Error(`平台节点模块不匹配：${installed.module}`);
  }
  if (
    installed.observedVersions.length !== 1
    || installed.observedVersions[0] !== PLATFORM_NODE_PACKAGE.version
  ) {
    throw new Error(`平台节点观察到不一致版本：${installed.observedVersions.join(', ')}`);
  }
  if (installed.version !== PLATFORM_NODE_PACKAGE.version) {
    throw new Error(`平台节点版本不匹配：${installed.version}`);
  }
  if (installed.nodeSets.length !== PLATFORM_NODE_TYPES.length) {
    throw new Error('平台节点必须恰好有 three node sets，不能有 extra set');
  }
  const types: string[] = [];
  for (const nodeSet of installed.nodeSets) {
    if (nodeSet.module !== PLATFORM_NODE_PACKAGE.name || nodeSet.version !== PLATFORM_NODE_PACKAGE.version) {
      throw new Error('平台 node set 的模块或版本不匹配');
    }
    if (!nodeSet.enabled) throw new Error(`平台 node set 未 enabled：${nodeSet.id}`);
    if (nodeSet.err) throw new Error(`平台 node set 有 error：${nodeSet.err}`);
    if (nodeSet.types.length !== 1) throw new Error(`平台 node set 有 extra 类型：${nodeSet.id}`);
    types.push(nodeSet.types[0]!);
  }
  const sortedTypes = [...types].sort();
  if (new Set(sortedTypes).size !== sortedTypes.length) {
    throw new Error('平台 node set 有 duplicate 类型');
  }
  const expected = [...PLATFORM_NODE_TYPES].sort();
  if (sortedTypes.join('\u0000') !== expected.join('\u0000')) {
    throw new Error(`平台节点类型不匹配：${sortedTypes.join(', ')}`);
  }
}

/**
 * 读一台实例的节点台账。
 *
 * 实例连不上时不抛错，而是回一条 ok:false 的记录：列表页不能因一台停机就 500。
 */
export async function inventoryOf(
  instanceId: string,
  target: AdminTarget,
  approved: ReadonlySet<string>,
  fetchImpl: FetchLike = fetch,
): Promise<InstanceInventory> {
  try {
    const inventory = aggregateNodeSets(await getInstalledNodeSets(target, fetchImpl));
    const items = inventory.modules.map((module) => ({
      ...module, compliance: classify(module, approved),
    }));
    return {
      instanceId,
      ok: true,
      reason: '',
      modules: items,
      unapproved: items.filter((item) => item.compliance === 'unapproved').length,
    };
  } catch (e) {
    const reason = e instanceof AdminApiError ? e.message : `读取失败：${(e as Error).message}`;
    return { instanceId, ok: false, reason, modules: [], unapproved: 0 };
  }
}
