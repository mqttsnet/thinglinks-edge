/**
 * 端口分配 —— 用户自填，系统只推荐。
 *
 * 现场工程师通常已有既定端口规划，系统硬分配反而添乱。
 * 系统负责的是：格式解析、范围校验、冲突检测（平台记录 + 宿主实际占用）。
 */
import { createServer } from 'node:net';

export class PortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortError';
  }
}

export interface PortRange {
  min: number;
  max: number;
}

/** 单个区间允许的最大端口数，防止误写 30000-40000 之类 */
const MAX_SPAN = 200;

export interface ParseResult {
  ports: number[];
  /** 无法解析的片段，原样回报便于用户定位 */
  invalid: string[];
}

/** 解析用户输入：支持区间 30101-30120、单个 30101、组合 30101-30110,30150 */
export function parsePortSpec(spec: string): ParseResult {
  const ports: number[] = [];
  const invalid: string[] = [];
  const seen = new Set<number>();

  for (const seg of String(spec ?? '').split(/[,，\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(seg);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        invalid.push(`${seg}（起始端口大于结束端口）`);
        continue;
      }
      if (to - from + 1 > MAX_SPAN) {
        invalid.push(`${seg}（单个区间超过 ${MAX_SPAN} 个端口）`);
        continue;
      }
      for (let p = from; p <= to; p++) {
        if (!seen.has(p)) { seen.add(p); ports.push(p); }
      }
      continue;
    }
    if (/^\d+$/.test(seg)) {
      const p = Number(seg);
      if (!seen.has(p)) { seen.add(p); ports.push(p); }
      continue;
    }
    invalid.push(`${seg}（格式无法识别）`);
  }
  return { ports, invalid };
}

export interface ConflictReport {
  outOfRange: number[];
  /** 端口 → 占用它的实例 */
  taken: Array<{ port: number; owner: string }>;
}

/** 与平台已分配记录比对 */
export function checkAgainstRecords(
  ports: number[],
  range: PortRange,
  used: Map<number, string>,
): ConflictReport {
  const outOfRange = ports.filter((p) => p < range.min || p > range.max);
  const taken = ports
    .filter((p) => used.has(p))
    .map((p) => ({ port: p, owner: used.get(p)! }));
  return { outOfRange, taken };
}

/** 探测宿主实际占用 —— 平台记录之外，可能有其它进程占着 */
export async function probeHostPort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));   // 绑定失败 = 已被占用
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
}

export async function probeHostPorts(ports: number[], host = '127.0.0.1'): Promise<number[]> {
  const busy: number[] = [];
  for (const p of ports) {
    if (await probeHostPort(p, host)) busy.push(p);
  }
  return busy;
}

/**
 * 推荐一段连续空闲端口。只作建议，用户可改。
 * 按 step 对齐，便于人肉记忆与分区管理。
 */
export function recommendPorts(
  count: number,
  range: PortRange,
  used: Map<number, string>,
  step = 20,
): string {
  if (count <= 0) return '';
  for (let start = range.min; start + count - 1 <= range.max; start += step) {
    let free = true;
    for (let p = start; p < start + count; p++) {
      if (used.has(p)) { free = false; break; }
    }
    if (free) return count === 1 ? String(start) : `${start}-${start + count - 1}`;
  }
  return '';
}

/** 端口输入的完整校验：解析 → 范围 → 平台记录 → 宿主实际占用 */
export async function validatePortSpec(
  spec: string,
  range: PortRange,
  used: Map<number, string>,
  opts: { probeHost?: boolean; hostIp?: string } = {},
): Promise<number[]> {
  const { ports, invalid } = parsePortSpec(spec);
  const problems: string[] = [];

  if (invalid.length > 0) problems.push(`无法解析：${invalid.join('、')}`);

  const { outOfRange, taken } = checkAgainstRecords(ports, range, used);
  if (outOfRange.length > 0) {
    problems.push(`超出允许范围 ${range.min}-${range.max}：${outOfRange.slice(0, 5).join('、')}${outOfRange.length > 5 ? ' 等' : ''}`);
  }
  if (taken.length > 0) {
    problems.push(`已被占用：${taken.slice(0, 4).map((t) => `${t.port}（${t.owner}）`).join('、')}${taken.length > 4 ? ' 等' : ''}`);
  }

  if (problems.length === 0 && opts.probeHost !== false && ports.length > 0) {
    const busy = await probeHostPorts(ports, opts.hostIp ?? '127.0.0.1');
    if (busy.length > 0) {
      problems.push(`宿主上已被其它进程占用：${busy.slice(0, 5).join('、')}${busy.length > 5 ? ' 等' : ''}`);
    }
  }

  if (problems.length > 0) throw new PortError(problems.join('；'));
  return ports;
}
