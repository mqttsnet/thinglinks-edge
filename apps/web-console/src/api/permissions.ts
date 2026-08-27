/**
 * 当前登录者的权限，全站共用一份（T4.4）。
 *
 * 用途只有一个：**别把用户点了必然 403 的按钮摆在他面前**。
 * 一个满屏按钮、点哪个都提示「权限不足」的界面，比按钮少几个更糟 ——
 * 现场人员会以为系统坏了，然后打电话。
 *
 * 但它**不是安全边界**：这份数据在浏览器里，改一行 JS 就能让按钮出现。
 * 真正的判定始终在 Manager 的 guard 里，前端隐藏与后端拒绝两件事都要做。
 */
import { ref } from 'vue';
import { api } from './client';
import type { GrantLevel, MyPermissions } from './types';

const perms = ref<MyPermissions | null>(null);
let inflight: Promise<void> | undefined;

/** 取一次并缓存。并发调用共享同一次请求，不会打出 N 个 /api/me/permissions */
export async function loadPermissions(force = false): Promise<void> {
  if (perms.value && !force) return;
  if (!inflight) {
    inflight = api.myPermissions()
      .then((p) => { perms.value = p; })
      .catch(() => { perms.value = null; })
      .finally(() => { inflight = undefined; });
  }
  return inflight;
}

/** 登出或换人登录后必须清掉，否则新会话会沿用上一个人的权限做界面判断 */
export function clearPermissions(): void {
  perms.value = null;
}

/** 系统级动作。取不到权限时一律按「不能」——宁可少显示，不可误显示 */
export function can(action: string): boolean {
  return perms.value?.actions.includes(action) ?? false;
}

/** 某台实例上的授权档位；admin 恒为 operate */
export function grantOn(instanceId: string): GrantLevel | undefined {
  const p = perms.value;
  if (!p) return undefined;
  if (p.instances === 'all') return 'operate';
  return p.instances.find((g) => g.instanceId === instanceId)?.level;
}

/** 能否对这台实例做改动（启停、重置口令、改流程） */
export function canOperate(instanceId: string): boolean {
  return can('instance:operate') && grantOn(instanceId) === 'operate';
}

export function usePermissions() {
  return { perms, can, canOperate, grantOn, loadPermissions };
}
