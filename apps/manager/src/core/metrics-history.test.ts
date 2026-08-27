import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MetricsHistory, MetricsSampler, aggregate, collectSample, filterSeries,
  type MetricSample, type MetricsSource,
} from './metrics-history.ts';
import type { HostStats } from './host-stats.ts';
import type { InstanceHealth } from './health.ts';

const sample = (t: number, over: Partial<MetricSample> = {}): MetricSample => ({
  t,
  host: { loadPercent: 10, memPercent: 50, diskPercent: 30 },
  instances: {
    'line-1': { cpuPercent: 5, memUsedMb: 64, memPercent: 12.5, latencyMs: 3, verdict: 'healthy' },
  },
  ...over,
});

test('细档写满后覆盖最旧的点', () => {
  const h = new MetricsHistory({ fineStepSec: 10, fineSpanSec: 30 }); // 容量 3
  for (let i = 1; i <= 5; i += 1) h.record(sample(i * 10_000));
  const { points } = h.query(30, 50_000);
  assert.deepEqual(points.map((p) => p.t), [30_000, 40_000, 50_000]);
});

test('窗口外的点不返回', () => {
  const h = new MetricsHistory();
  h.record(sample(900_000));
  h.record(sample(1_600_000));
  const { points } = h.query(600, 1_600_000); // 只要最近 10 分钟
  assert.deepEqual(points.map((p) => p.t), [1_600_000]);
});

test('超过细档保留时长的查询自动降到粗档', () => {
  const h = new MetricsHistory({ fineStepSec: 10, fineSpanSec: 3600, coarseStepSec: 300 });
  assert.equal(h.query(3600).stepSec, 10);
  assert.equal(h.query(21_600).stepSec, 300);
});

test('粗档按间隔聚合，并带上正在攒的那个桶', () => {
  const h = new MetricsHistory({ fineStepSec: 10, fineSpanSec: 60, coarseStepSec: 300 });
  // 第一个 5 分钟桶：两点，负载 10 与 30
  h.record(sample(0, { host: { loadPercent: 10, memPercent: 50, diskPercent: 30 }, instances: {} }));
  h.record(sample(60_000, { host: { loadPercent: 30, memPercent: 50, diskPercent: 30 }, instances: {} }));
  // 跨到第二个桶，触发上一个桶落盘
  h.record(sample(400_000, { host: { loadPercent: 80, memPercent: 50, diskPercent: 30 }, instances: {} }));

  const { points } = h.query(86_400, 400_000);
  assert.equal(points.length, 2, '一个已落盘 + 一个正在攒');
  assert.equal(points[0]?.host.loadPercent, 20, '(10+30)/2');
  assert.equal(points[0]?.t, 0, '桶时间对齐到桶起点');
  assert.equal(points[1]?.host.loadPercent, 80);
});

test('聚合取最坏状态，不把 down 平均掉', () => {
  const p = (v: InstanceHealth['verdict']): MetricSample => sample(0, {
    instances: { a: { cpuPercent: 1, memUsedMb: 1, memPercent: 1, latencyMs: 1, verdict: v } },
  });
  assert.equal(aggregate([p('healthy'), p('down'), p('healthy')], 0).instances['a']?.verdict, 'down');
  assert.equal(aggregate([p('healthy'), p('degraded')], 0).instances['a']?.verdict, 'degraded');
  assert.equal(aggregate([p('healthy'), p('healthy')], 0).instances['a']?.verdict, 'healthy');
});

test('聚合时 null 不当成 0；全是 null 才返回 null', () => {
  const withLoad = (loadPercent: number | null): MetricSample =>
    sample(0, { host: { loadPercent, memPercent: null, diskPercent: null }, instances: {} });
  assert.equal(aggregate([withLoad(null), withLoad(40)], 0).host.loadPercent, 40, 'null 被跳过而非拉低均值');
  assert.equal(aggregate([withLoad(null), withLoad(null)], 0).host.loadPercent, null);
});

test('实例中途出现或消失时，只聚合它在场的那些点', () => {
  const empty = sample(0, { instances: {} });
  const withA = sample(10_000);
  const agg = aggregate([empty, withA], 0);
  assert.equal(agg.instances['line-1']?.cpuPercent, 5);
});

test('窗口内出现过的实例 id 会被汇总出来', () => {
  const h = new MetricsHistory();
  h.record(sample(1000));
  h.record(sample(2000, {
    instances: { 'line-2': { cpuPercent: 1, memUsedMb: 2, memPercent: 3, latencyMs: 4, verdict: 'down' } },
  }));
  assert.deepEqual(h.query(3600, 2000).instanceIds, ['line-1', 'line-2']);
});

test('还没采过时给出空序列而不是报错', () => {
  const h = new MetricsHistory();
  const s = h.query(3600);
  assert.deepEqual(s.points, []);
  assert.equal(s.firstSampleAt, null);
  assert.equal(h.latest(), undefined);
});

// ── 采样点的构造 ───────────────────────────────────────────

const host: HostStats = {
  cpuCount: 4, loadPercent: 12.5, memTotalMb: 8000, memUsedMb: 4000, memPercent: 50,
  memReliable: true, diskTotalGb: 100, diskUsedGb: 40, diskPercent: 40, uptimeSec: 99,
};

const health = (over: Partial<InstanceHealth> = {}): InstanceHealth => ({
  id: 'line-1',
  container: { state: 'running', running: true, restartCount: 0, startedAt: null,
               cpuPercent: 7, memUsedMb: 128, memLimitMb: 512 },
  app: { ok: true, status: 200, latencyMs: 9 },
  flow: { started: true, recentErrors: 0, lastError: null },
  verdict: 'healthy',
  ...over,
});

const source = (healths: InstanceHealth[]): MetricsSource => ({
  hostStats: async () => host,
  healthAll: async () => healths,
});

test('采样点把内存换算成占配额的百分比', async () => {
  const s = await collectSample(source([health()]), 5000);
  assert.equal(s.t, 5000);
  assert.equal(s.instances['line-1']?.memPercent, 25, '128/512');
  assert.equal(s.instances['line-1']?.cpuPercent, 7);
  assert.equal(s.host.loadPercent, 12.5);
});

test('探针不通时延迟记 null —— 失败耗时不是延迟', async () => {
  const s = await collectSample(source([health({
    app: { ok: false, status: null, latencyMs: 5000, error: '探测超时' },
    verdict: 'down',
  })]), 0);
  assert.equal(s.instances['line-1']?.latencyMs, null);
  assert.equal(s.instances['line-1']?.verdict, 'down');
});

test('没有内存配额时不硬算百分比', async () => {
  const s = await collectSample(source([health({
    container: { state: 'running', running: true, restartCount: 0, startedAt: null,
                 cpuPercent: null, memUsedMb: 64, memLimitMb: null },
  })]), 0);
  assert.equal(s.instances['line-1']?.memPercent, null);
  assert.equal(s.instances['line-1']?.memUsedMb, 64);
});

test('上一轮没跑完时跳过这一轮，不排队堆积', async () => {
  const history = new MetricsHistory();
  let release: (() => void) | undefined;
  const slow: MetricsSource = {
    hostStats: async () => host,
    healthAll: () => new Promise((resolve) => { release = () => resolve([health()]); }),
  };
  const sampler = new MetricsSampler({ history, source: slow, intervalMs: 10 });

  const first = sampler.tick();
  assert.equal(await sampler.tick(), false, '上一轮还卡着，这一轮直接跳过');
  release?.();
  assert.equal(await first, true);
  assert.equal(history.query(3600).points.length, 1);
});

test('探针抛错时采样器不崩，交给 onError', async () => {
  const history = new MetricsHistory();
  const errors: unknown[] = [];
  const sampler = new MetricsSampler({
    history,
    source: { hostStats: async () => host, healthAll: async () => { throw new Error('docker 不可达'); } },
    intervalMs: 10,
    onError: (e) => errors.push(e),
  });
  assert.equal(await sampler.tick(), false);
  assert.equal((errors[0] as Error).message, 'docker 不可达');
  assert.equal(history.query(3600).points.length, 0);
});

// ── 按授权裁剪（T4.4）─────────────────────────────────────

const twoInstances = (): MetricsHistory => {
  const h = new MetricsHistory();
  h.record(sample(1000, {
    instances: {
      'line-a': { cpuPercent: 1, memUsedMb: 10, memPercent: 2, latencyMs: 3, verdict: 'healthy' },
      'line-b': { cpuPercent: 9, memUsedMb: 90, memPercent: 20, latencyMs: 30, verdict: 'down' },
    },
  }));
  return h;
};

test('只返回授权范围内的实例，未授权的连 id 都不出现', () => {
  const s = filterSeries(twoInstances().query(3600, 1000), new Set(['line-a']));
  assert.deepEqual(s.instanceIds, ['line-a']);
  assert.deepEqual(Object.keys(s.points[0]?.instances ?? {}), ['line-a']);
});

test('宿主读数不裁剪 —— 那是整机的，与实例授权无关', () => {
  const s = filterSeries(twoInstances().query(3600, 1000), new Set(['line-a']));
  assert.equal(s.points[0]?.host.memPercent, 50);
});

test('一台都没授权时给空实例集，而不是全给', () => {
  const s = filterSeries(twoInstances().query(3600, 1000), new Set<string>());
  assert.deepEqual(s.instanceIds, []);
  assert.deepEqual(Object.keys(s.points[0]?.instances ?? {}), []);
});

test("admin 传 'all' 时原样返回", () => {
  const raw = twoInstances().query(3600, 1000);
  assert.deepEqual(filterSeries(raw, 'all').instanceIds, ['line-a', 'line-b']);
});
