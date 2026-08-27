import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercent, memoryUsage, analyzeLogs, judge, type DockerStatsLike } from './health.ts';

const stats = (over: Partial<DockerStatsLike> = {}): DockerStatsLike => ({
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000 },
    system_cpu_usage: 20_000_000_000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_000_000_000 },
    system_cpu_usage: 18_000_000_000,
  },
  memory_stats: { usage: 300 * 1048576, limit: 512 * 1048576, stats: { cache: 44 * 1048576 } },
  ...over,
});

test('CPU 百分比按增量与核数计算', () => {
  // 容器增量 1e9，系统增量 2e9，4 核 → 1/2*4 = 200%
  assert.equal(cpuPercent(stats()), 200);
});

test('系统增量为零或负时返回 null 而非除零', () => {
  assert.equal(cpuPercent(stats({
    cpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 18e9, online_cpus: 4 },
  })), null);
});

test('缺字段时返回 null 而非 NaN', () => {
  assert.equal(cpuPercent({}), null);
  assert.equal(cpuPercent({ cpu_stats: { cpu_usage: {} } }), null);
});

test('核数缺失时退化为单核', () => {
  const s = stats({
    cpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 20e9 },
  });
  assert.equal(cpuPercent(s), 50, '1/2*1 = 50%');
});

test('内存扣除页缓存，避免虚高', () => {
  const m = memoryUsage(stats());
  assert.equal(m.usedMb, 256, '300MB 用量减去 44MB 缓存');
  assert.equal(m.limitMb, 512);
});

test('无缓存字段时按原始用量计', () => {
  const m = memoryUsage(stats({ memory_stats: { usage: 100 * 1048576, limit: 256 * 1048576 } }));
  assert.equal(m.usedMb, 100);
});

test('日志分析识别 flow 已启动', () => {
  const h = analyzeLogs('17 Aug - [info] Starting flows\n17 Aug - [info] Started flows');
  assert.equal(h.started, true);
  assert.equal(h.recentErrors, 0);
  assert.equal(h.lastError, null);
});

test('日志分析统计错误并保留最后一条', () => {
  const h = analyzeLogs([
    '[info] Started flows',
    '[error] TypeError: cannot read property "a"',
    '[error] Connection refused 192.168.30.80:502',
  ].join('\n'));
  assert.equal(h.recentErrors, 2);
  assert.match(h.lastError ?? '', /Connection refused/);
});

test('综合判定：容器未运行为 down', () => {
  const c = { state: 'exited', running: false, restartCount: 3, startedAt: null, cpuPercent: null, memUsedMb: null, memLimitMb: null };
  assert.equal(judge(c, { ok: true, status: 200, latencyMs: 5 }, { started: true, recentErrors: 0, lastError: null }), 'down');
});

test('综合判定：容器在跑但 HTTP 不通也是 down —— 进程假死', () => {
  const c = { state: 'running', running: true, restartCount: 0, startedAt: null, cpuPercent: 1, memUsedMb: 100, memLimitMb: 512 };
  assert.equal(judge(c, { ok: false, status: null, latencyMs: null }, { started: true, recentErrors: 0, lastError: null }), 'down');
});

test('综合判定：有错误或 flow 未启动为 degraded', () => {
  const c = { state: 'running', running: true, restartCount: 0, startedAt: null, cpuPercent: 1, memUsedMb: 100, memLimitMb: 512 };
  const app = { ok: true, status: 200, latencyMs: 5 };
  assert.equal(judge(c, app, { started: false, recentErrors: 0, lastError: null }), 'degraded');
  assert.equal(judge(c, app, { started: true, recentErrors: 2, lastError: 'x' }), 'degraded');
  assert.equal(judge(c, app, { started: true, recentErrors: 0, lastError: null }), 'healthy');
});

// ── 宿主资源守卫 ────────────────────────────────────────

import { isExhausted, type HostStats } from './host-stats.ts';

const host = (over: Partial<HostStats> = {}): HostStats => ({
  cpuCount: 8, loadPercent: 30,
  memTotalMb: 8192, memUsedMb: 4096, memPercent: 50, memReliable: true,
  diskTotalGb: 100, diskUsedGb: 50, diskPercent: 50,
  uptimeSec: 1000, ...over,
});

test('资源充足时放行', () => {
  assert.equal(isExhausted(host()).exhausted, false);
});

test('内存与磁盘超阈值时拦截并说明原因', () => {
  assert.match(isExhausted(host({ memPercent: 95 })).reason ?? '', /内存已用 95/);
  assert.match(isExhausted(host({ diskPercent: 95 })).reason ?? '', /磁盘已用 95/);
});

test('内存读数不可信时不据此拦截 —— 宁可放行也不误拦健康机器', () => {
  // totalmem - freemem 在 macOS / 有大量缓存的 Linux 上会虚高到 99%+
  assert.equal(isExhausted(host({ memPercent: 99.7, memReliable: false })).exhausted, false);
  // 但磁盘读数始终可信，仍应拦截
  assert.equal(isExhausted(host({ memPercent: 99.7, memReliable: false, diskPercent: 95 })).exhausted, true);
});

test('拿不到磁盘读数时不因此拦截', () => {
  assert.equal(isExhausted(host({ diskPercent: null })).exhausted, false);
});
