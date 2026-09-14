import type { HostStats } from '../health/host-stats.ts';

/** Registration reserves limits even for stopped instances, so starting them cannot oversubscribe. */
export function assertInstanceResourceBudget(
  host: Pick<HostStats, 'cpuCount' | 'memTotalMb'>,
  instances: readonly { memLimit: number; cpuLimit: number }[],
  requested: { memoryMb: number; cpus: number },
): void {
  if (!Number.isFinite(host.cpuCount) || host.cpuCount < 1
    || !Number.isFinite(host.memTotalMb) || host.memTotalMb < 1) {
    throw new Error('无法确认宿主资源容量，暂不能分配新实例');
  }
  if (!Number.isInteger(requested.memoryMb) || requested.memoryMb < 64
    || !Number.isFinite(requested.cpus) || requested.cpus <= 0) {
    throw new Error('实例内存与 CPU 配额必须是有效的正数');
  }
  let memory = requested.memoryMb, cpu = requested.cpus;
  for (const instance of instances) {
    if (!Number.isFinite(instance.memLimit) || instance.memLimit <= 0
      || !Number.isFinite(instance.cpuLimit) || instance.cpuLimit <= 0) {
      throw new Error('已有实例资源配额未确认，请先核对后再创建');
    }
    memory += instance.memLimit; cpu += instance.cpuLimit;
  }
  const memoryBudget = Math.floor(host.memTotalMb - Math.max(512, host.memTotalMb * 0.2));
  const cpuBudget = host.cpuCount - Math.max(0.5, host.cpuCount * 0.1);
  if (memory > memoryBudget) throw new Error(`实例内存预算不足：合计 ${memory} MB，可分配 ${Math.max(0, memoryBudget)} MB，已为宿主保留余量`);
  if (cpu > cpuBudget + 1e-9) throw new Error(`实例 CPU 预算不足：合计 ${cpu.toFixed(2)} 核，可分配 ${cpuBudget.toFixed(2)} 核，已为宿主保留余量`);
}
