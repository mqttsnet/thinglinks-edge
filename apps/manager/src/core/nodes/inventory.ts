/**
 * 平台侧节点台账（01 号文 5.7「平台侧可查看各实例已安装的节点清单」）。
 *
 * 清单本身由实例现答（Admin API），这里不缓存 —— 缓存一份「上次看到的节点」
 * 只会在现场手工装过东西之后骗人，而节点管理恰恰是要发现这种偏差的地方。
 *
 * 除了「装了什么」，还回答一个更有用的问题：**装的东西合不合规**。
 * 白名单是在实例 settings.js 里生效的，而 settings.js 是创建/改配置那一刻写的 ——
 * 中间批准清单改过、实例还没重写配置的话，两者就会不一致。
 * 那种漂移不主动查是看不见的。
 */
import { getInstalledModules, AdminApiError, type AdminTarget, type FetchLike, type InstalledModule }
  from '../flows/admin-client.ts';

/** 一条节点在合规意义上的判定 */
export type NodeCompliance =
  /** 镜像自带 */
  | 'builtin'
  /** 平台自己拷进去的 @thinglinks 节点集 */
  | 'platform'
  /** 在批准清单里 */
  | 'approved'
  /** 不在批准清单里 —— 多半是白名单生效之前装的，需要人来判断 */
  | 'unapproved';

export interface InventoryItem extends InstalledModule {
  compliance: NodeCompliance;
}

export interface InstanceInventory {
  instanceId: string;
  /** 读取成功与否。失败时 modules 为空，reason 说明原因 */
  ok: boolean;
  reason: string;
  modules: InventoryItem[];
  /** 不在批准清单内的模块数，界面上直接用它标红 */
  unapproved: number;
}

/** 平台自己塞进去的节点集前缀，不该被当成「现场私装」 */
const PLATFORM_SCOPE = '@thinglinks/';

export function classify(m: InstalledModule, approved: ReadonlySet<string>): NodeCompliance {
  if (!m.local) return 'builtin';
  if (m.module.startsWith(PLATFORM_SCOPE)) return 'platform';
  return approved.has(m.module) ? 'approved' : 'unapproved';
}

/**
 * 读一台实例的节点台账。
 *
 * **实例连不上时不抛错**，而是回一条 ok:false 的记录。
 * 台账是个列表页，一台停机的实例不该让整页 500 —— 现场停一台机器是常事，
 * 而那正是需要看台账的时候。
 */
export async function inventoryOf(
  instanceId: string,
  target: AdminTarget,
  approved: ReadonlySet<string>,
  fetchImpl: FetchLike = fetch,
): Promise<InstanceInventory> {
  try {
    const modules = await getInstalledModules(target, fetchImpl);
    const items = modules.map((m) => ({ ...m, compliance: classify(m, approved) }));
    return {
      instanceId,
      ok: true,
      reason: '',
      modules: items,
      unapproved: items.filter((i) => i.compliance === 'unapproved').length,
    };
  } catch (e) {
    const reason = e instanceof AdminApiError
      ? e.message
      : `读取失败：${(e as Error).message}`;
    return { instanceId, ok: false, reason, modules: [], unapproved: 0 };
  }
}
