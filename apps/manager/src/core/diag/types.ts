/**
 * 诊断探针的结果类型（T4.5）。
 *
 * 单独成文件是为了让 dns / tcp / ntp 三个探针互不依赖：
 * 它们各自只 import 这里，谁都不用去 import 另一个探针。
 */

/** 探针统一的超时，毫秒。现场网络慢，但排障时也不能让人干等 */
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface DnsResult {
  host: string;
  ok: boolean;
  addresses: string[];
  elapsedMs: number;
  error?: string;
}

export interface TcpResult {
  host: string;
  port: number;
  ok: boolean;
  elapsedMs: number;
  /** 实际连到的地址，双栈环境下用于确认走的是 v4 还是 v6 */
  remoteAddress?: string;
  error?: string;
}

export interface ClockResult {
  /** 本机时钟，ISO8601 */
  localTime: string;
  timezone: string;
  /** 进程已运行秒数，用于判断刚重启过没有 */
  uptimeSec: number;
  /** 配了时钟源才有；正数表示本机比参考时间慢 */
  offsetMs?: number;
  roundtripMs?: number;
  server?: string;
  ok: boolean;
  /** 没配时钟源时说明原因，而不是假装检查过 */
  note: string;
}

/** 一次「解析 + 连通」的合并结论 */
export interface EndpointProbe {
  target: string;
  dns: DnsResult;
  /** 解析都没成功时为 null —— 那时候根本没去连 */
  tcp: TcpResult | null;
  summary: string;
}
