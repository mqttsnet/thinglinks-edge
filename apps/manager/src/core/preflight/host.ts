/**
 * 宿主环境的安装自检（T6.2）：端口占用、磁盘空间、系统时钟。
 *
 * 三项都不碰 Docker，可以在任何环境下单独跑。
 */
import { probeHostPort } from '../instance/ports.ts';
import { readClock } from '../diag/ntp.ts';
import { pass, fail, skip, type CheckResult } from './types.ts';

/** 数据盘可用空间下限。低于它连一次备份加一次升级都放不下 */
const MIN_FREE_GB = 5;
/** 低于这个比例就该提醒了 —— 断网缓存写在这块盘上 */
const WARN_FREE_GB = 20;

/**
 * 端口占用 —— 失败**阻断，并给出可用建议**。
 *
 * 用**绑定**探测而不是连接探测：连接探测只能发现「有人在听」，
 * 发现不了「端口被别的进程独占了绑定权但还没监听」，
 * 而后者恰恰会让 Manager 启动时才失败 —— 那时候已经装完了。
 *
 * 实例端口段只抽样：整段一千个端口逐个绑一遍要几十秒，
 * 而自检必须快到让人愿意跑。抽样够回答「这段能不能用」。
 */
export async function checkPorts(
  listenAddr: string, listenPort: number,
  range: { min: number; max: number }, sampleSize = 20,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  const busy = await probeHostPort(listenPort, listenAddr === '0.0.0.0' ? '0.0.0.0' : listenAddr);
  out.push(busy
    ? fail('host.port.manager', '管理面端口占用', 'block',
        `${listenAddr}:${listenPort} 已被占用。换一个端口（LISTEN_PORT / HOST_PORT），`
        + '或先停掉占用它的进程', { listenAddr, listenPort })
    : pass('host.port.manager', '管理面端口占用', `${listenAddr}:${listenPort} 可用`,
        { listenAddr, listenPort }));

  const total = range.max - range.min + 1;
  const step = Math.max(1, Math.floor(total / sampleSize));
  const sampled: number[] = [];
  for (let p = range.min; p <= range.max && sampled.length < sampleSize; p += step) sampled.push(p);

  const busyPorts: number[] = [];
  for (const p of sampled) if (await probeHostPort(p, '127.0.0.1')) busyPorts.push(p);

  const data = { range, sampled: sampled.length, total, busy: busyPorts };
  if (busyPorts.length === 0) {
    out.push(pass('host.port.range', '实例端口段占用',
      `${range.min}-${range.max} 抽查 ${sampled.length} 个全部可用`, data));
  } else if (busyPorts.length >= sampled.length) {
    out.push(fail('host.port.range', '实例端口段占用', 'block',
      `${range.min}-${range.max} 抽查的 ${sampled.length} 个端口全被占用，这段不能用。`
      + '换一段（INSTANCE_PORT_MIN / INSTANCE_PORT_MAX），建议避开 32768 以上的临时端口范围', data));
  } else {
    out.push(fail('host.port.range', '实例端口段占用', 'warn',
      `${range.min}-${range.max} 抽查 ${sampled.length} 个，其中 ${busyPorts.length} 个被占用`
      + `（${busyPorts.join(' ')}）。段还能用，但可分配的实例数变少了`, data));
  }
  return out;
}

/** 磁盘可用空间 —— 失败**阻断** */
export function checkDisk(
  stats: { diskTotalGb: number | null; diskUsedGb: number | null; diskPercent: number | null },
  dataDir: string,
): CheckResult {
  const id = 'host.disk';
  const name = '磁盘可用空间';
  if (stats.diskTotalGb === null || stats.diskUsedGb === null) {
    return skip(id, name, `读不到 ${dataDir} 的磁盘用量（容器内可能未挂载对应文件系统）`);
  }
  const freeGb = Math.max(0, stats.diskTotalGb - stats.diskUsedGb);
  const data = { dataDir, freeGb: Number(freeGb.toFixed(1)), ...stats };
  if (freeGb < MIN_FREE_GB) {
    return fail(id, name, 'block',
      `${dataDir} 只剩 ${freeGb.toFixed(1)} GB，低于 ${MIN_FREE_GB} GB 下限。`
      + '断网缓存、备份、镜像都写在这里，空间不足会让缓存开始丢数据', data);
  }
  if (freeGb < WARN_FREE_GB) {
    return fail(id, name, 'warn',
      `${dataDir} 剩余 ${freeGb.toFixed(1)} GB，低于建议的 ${WARN_FREE_GB} GB。`
      + '断网缓存默认上限 2 GB，加上镜像与备份，长期运行会紧张', data);
  }
  return pass(id, name, `${dataDir} 剩余 ${freeGb.toFixed(1)} GB`, data);
}

/**
 * 系统时钟偏差 —— 失败**告警**。
 *
 * 未配 NTP_SERVER 时**跳过而不是通过**：没检查就是没检查。
 * 时钟偏差会让云侧验签失败，表现是「连接正常但数据不进库」，
 * 与 signKey 填错一模一样，是最难查的一类。
 */
export async function checkClock(ntpServer: string, timeoutMs = 5_000): Promise<CheckResult> {
  const id = 'host.clock';
  const name = '系统时钟偏差';
  const c = await readClock(ntpServer, timeoutMs);
  const data = { ...c } as unknown as Record<string, unknown>;
  if (!ntpServer.trim()) {
    return skip(id, name,
      `未配置 NTP_SERVER，只能报告本机时钟（${c.localTime} ${c.timezone}），未与外部参考比对。`
      + '时钟偏差会让云侧验签失败，表现与 signKey 填错完全一样，建议配一个内网 NTP');
  }
  if (!c.ok) {
    return fail(id, name, 'warn', c.note, data);
  }
  return pass(id, name, `${c.note} · 时区 ${c.timezone}`, data);
}
