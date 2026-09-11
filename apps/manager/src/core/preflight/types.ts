/**
 * 安装自检的结果类型（T6.2 / `03-复杂网络环境适配.md` 第 3 节）。
 *
 * 自检的意义是**在装之前把问题暴露出来**，而不是装完了再排查 ——
 * 现场部署失败最贵的不是修复本身，是「装完发现不行，再从头查一遍」那段时间。
 */

/**
 * 失败等级。**由规格逐项指定，不由实现自行判断**（03 号文第 3 节的表格）。
 *
 * · `block` —— 装下去必然不能用，宁可当场停住
 * · `warn`  —— 能装，但现场很可能踩坑，必须让人看见并知道后果
 * · `info`  —— 只是把环境事实记下来，供交付材料留档
 */
export type CheckSeverity = 'block' | 'warn' | 'info';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  /** 稳定的机器可读标识，报告比对与自动化据此定位，不要随文案改动 */
  id: string;
  /** 人读的检查项名称，与 03 号文表格一致 */
  name: string;
  status: CheckStatus;
  /** 只有 fail 时才有意义；pass/skip 时忽略 */
  severity: CheckSeverity;
  /** 一句话结论。**失败时必须说清「是什么」和「怎么办」** */
  detail: string;
  /** 实测到的原始读数，供交付材料留档与事后比对 */
  data?: Record<string, unknown>;
}

export interface PreflightReport {
  generatedAt: string;
  /** 有 block 级失败时为 false —— 调用方据此决定是否继续安装 */
  ok: boolean;
  blocking: number;
  warnings: number;
  skipped: number;
  checks: CheckResult[];
}

export const pass = (id: string, name: string, detail: string,
                     data?: Record<string, unknown>): CheckResult =>
  ({ id, name, status: 'pass', severity: 'info', detail, ...(data ? { data } : {}) });

export const fail = (id: string, name: string, severity: CheckSeverity, detail: string,
                     data?: Record<string, unknown>): CheckResult =>
  ({ id, name, status: 'fail', severity, detail, ...(data ? { data } : {}) });

/**
 * 跳过。
 *
 * **跳过必须说明原因**，且不能算作通过 —— 「没检查」被当成「检查过了」，
 * 正是自检最容易变成安慰剂的方式。
 */
export const skip = (id: string, name: string, detail: string): CheckResult =>
  ({ id, name, status: 'skip', severity: 'info', detail });

export function summarize(checks: CheckResult[]): PreflightReport {
  const blocking = checks.filter((c) => c.status === 'fail' && c.severity === 'block').length;
  return {
    generatedAt: new Date().toISOString(),
    ok: blocking === 0,
    blocking,
    warnings: checks.filter((c) => c.status === 'fail' && c.severity === 'warn').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
    checks,
  };
}
