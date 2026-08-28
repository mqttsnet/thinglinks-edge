/**
 * 宿主资源 —— 单机部署下必须盯住，资源耗尽会拖垮全部实例。
 * 逼近上限时应阻止创建新实例，而不是等它把机器压垮。
 */
import { cpus, totalmem, freemem, loadavg, uptime } from 'node:os';
import { statfs, readFile } from 'node:fs/promises';

export interface HostStats {
  cpuCount: number;
  /** 1 分钟平均负载相对核数的百分比；Windows 上不可用时为 null */
  loadPercent: number | null;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  /**
   * 内存读数是否可信。
   * `totalmem - freemem` **不等于已用内存** —— 现代系统把大量内存用作可回收缓存
   * （macOS 的缓存/压缩内存、Linux 的 buffers/cache），据此判断会把健康机器误判为耗尽。
   * 只有能读到 Linux `/proc/meminfo` 的 MemAvailable 时才置 true。
   */
  memReliable: boolean;
  diskTotalGb: number | null;
  diskUsedGb: number | null;
  diskPercent: number | null;
  uptimeSec: number;
}

export async function readHostStats(dataDir = '/'): Promise<HostStats> {
  const cpuCount = cpus().length || 1;
  const total = totalmem();

  // 优先用 Linux 的 MemAvailable —— 它已扣除可回收缓存，是「还能用多少」的权威值
  let available: number | null = null;
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
    if (kb) available = Number(kb) * 1024;
  } catch {
    // 非 Linux（如开发机 macOS）取不到，下面标记读数不可信
  }
  const memReliable = available !== null;
  const used = total - (available ?? freemem());

  const load1 = loadavg()[0];
  const loadPercent = typeof load1 === 'number' && load1 > 0
    ? Math.round((load1 / cpuCount) * 1000) / 10
    : null;

  let diskTotalGb: number | null = null;
  let diskUsedGb: number | null = null;
  let diskPercent: number | null = null;
  try {
    const fs = await statfs(dataDir);
    const blockSize = Number(fs.bsize);
    const totalBytes = Number(fs.blocks) * blockSize;
    const freeBytes = Number(fs.bavail) * blockSize;
    if (totalBytes > 0) {
      diskTotalGb = Math.round((totalBytes / 1073741824) * 10) / 10;
      diskUsedGb = Math.round(((totalBytes - freeBytes) / 1073741824) * 10) / 10;
      diskPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10;
    }
  } catch {
    // 某些平台或容器内可能拿不到，留 null 而非报错
  }

  return {
    cpuCount,
    loadPercent,
    memTotalMb: Math.round(total / 1048576),
    memUsedMb: Math.round(used / 1048576),
    memPercent: Math.round((used / total) * 1000) / 10,
    memReliable,
    diskTotalGb, diskUsedGb, diskPercent,
    uptimeSec: Math.round(uptime()),
  };
}

/** 资源是否已逼近上限 —— 用于阻止创建新实例 */
export function isExhausted(h: HostStats, limits = { mem: 90, disk: 90 }): { exhausted: boolean; reason?: string } {
  // 读数不可信时不据此拦截 —— 宁可放行也不能在健康机器上误拦
  if (h.memReliable && h.memPercent >= limits.mem) {
    return { exhausted: true, reason: `宿主内存已用 ${h.memPercent}%` };
  }
  if (h.diskPercent !== null && h.diskPercent >= limits.disk) {
    return { exhausted: true, reason: `宿主磁盘已用 ${h.diskPercent}%` };
  }
  return { exhausted: false };
}
