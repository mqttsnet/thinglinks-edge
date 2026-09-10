import type { FieldDeviceRecord, Instance } from '../../api/types.ts';

export interface FieldDeviceStatus {
  online: boolean;
  label: string;
  instanceUnavailable: boolean;
}

const unavailableInstanceLabels = new Map([
  ['exited', '实例已停止'],
  ['created', '实例未启动'],
  ['paused', '实例已暂停'],
  ['restarting', '实例重启中'],
  ['missing', '实例不可用'],
  ['dead', '实例不可用'],
  ['removing', '实例移除中'],
]);

/** 只用明确的实例状态覆盖展示；不更改台账，也不从 lastSeen 推算超时。 */
export function fieldDeviceStatus(
  device: Pick<FieldDeviceRecord, 'online'>,
  instance?: Pick<Instance, 'state' | 'running'>,
): FieldDeviceStatus {
  const label = instance?.running === false ? unavailableInstanceLabels.get(instance.state) : undefined;
  if (label) return { online: false, label, instanceUnavailable: true };
  return { online: device.online, label: device.online ? '在线' : '离线', instanceUnavailable: false };
}
