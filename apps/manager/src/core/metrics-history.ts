/**
 * 资源指标历史 —— 健康监测画趋势曲线的数据源。
 *
 * 为什么需要它：三层探针给的是**此刻**的读数。可现场真正要回答的问题是
 * 「刚才那半小时它是不是一直好的」「内存是不是在往上爬」——
 * 只有快照的看板答不了，人只能盯着数字看，看不出趋势。
 *
 * 为什么只在内存里、不落库：边缘盒子多数用 SD / eMMC，每 10 秒写一次库、
 * 一年就是三百多万次写入，磨的是客户的卡；而这些点位的价值窗口只有几小时。
 * 代价是 **Manager 重启后曲线从零开始**，界面必须如实说明，不能装作有历史。
 *
 * 两档精度，理由是同一份数据要回答两种问题：
 *   · 细档 10 秒 × 1 小时  —— 「刚才那一下抖动是什么」
 *   · 粗档 5 分钟 × 24 小时 —— 「今天整体趋势如何」
 * 全按 10 秒存 24 小时是 8640 个点，既费内存又画不动；粗档由细档聚合而来。
 *
 * 内存量级：单点约 3 个宿主字段 + 每实例 5 个字段。10 个实例时
 * (360 + 288) × (3 + 50) ≈ 3.4 万个数，几 MB 以内。
 */
import type { HostStats } from './host-stats.ts';
import type { InstanceHealth } from './health.ts';

export type Verdict = InstanceHealth['verdict'];

export interface HostPoint {
  /** 1 分钟平均负载相对核数的百分比 */
  loadPercent: number | null;
  /**
   * 内存占用百分比。读数是否可信见 HostStats.memReliable ——
   * 这里不做过滤：可信与否是**解释**问题，界面已就地说明，
   * 在这里把数据丢掉只会让曲线莫名其妙地空一段。
   */
  memPercent: number | null;
  diskPercent: number | null;
}

export interface InstancePoint {
  cpuPercent: number | null;
  memUsedMb: number | null;
  /** 内存占**配额**的百分比；没有配额时为 null */
  memPercent: number | null;
  /** 应用层探针延迟；探针不通时为 null（失败耗时不是延迟，见采样器） */
  latencyMs: number | null;
  verdict: Verdict;
}

export interface MetricSample {
  /** 采样时刻（epoch 毫秒） */
  t: number;
  host: HostPoint;
  /** 键是实例 id。实例增删会让不同时刻的键不同，界面按缺失断线处理 */
  instances: Record<string, InstancePoint>;
}

export interface MetricsSeries {
  /** 本次返回的点间隔（秒），细档粗档不同 */
  stepSec: number;
  from: number;
  to: number;
  /** 第一次采样的时刻；null 表示还没采到过。界面据此说明「累计了多久」 */
  firstSampleAt: number | null;
  /** 时间升序 */
  points: MetricSample[];
  /** 窗口内出现过的实例 id，已排序 */
  instanceIds: string[];
}

/** 定容环形缓冲：写满即覆盖最旧的一格 */
class Ring<T> {
  private readonly buf: (T | undefined)[];
  private readonly capacity: number;
  private written = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.buf = new Array<T | undefined>(this.capacity);
  }

  push(value: T): void {
    this.buf[this.written % this.capacity] = value;
    this.written += 1;
  }

  get size(): number {
    return Math.min(this.written, this.capacity);
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = this.written - this.size; i < this.written; i += 1) {
      const v = this.buf[i % this.capacity];
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}

/** 严重程度排序：聚合一段时间时取**最坏**的那个，不能被平均掉 */
const SEVERITY: Record<Verdict, number> = { healthy: 0, degraded: 1, down: 2 };

function worstVerdict(list: Verdict[]): Verdict {
  return list.reduce<Verdict>((acc, v) => (SEVERITY[v] > SEVERITY[acc] ? v : acc), 'healthy');
}

/** 均值。全是 null 时返回 null —— 没数据和数据为 0 是两回事，不能混 */
function mean(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/** 把一批细档样本压成一个粗档点 */
export function aggregate(samples: MetricSample[], t: number): MetricSample {
  const ids = new Set<string>();
  for (const s of samples) for (const id of Object.keys(s.instances)) ids.add(id);

  const instances: Record<string, InstancePoint> = {};
  for (const id of ids) {
    const present = samples
      .map((s) => s.instances[id])
      .filter((p): p is InstancePoint => p !== undefined);
    instances[id] = {
      cpuPercent: mean(present.map((p) => p.cpuPercent)),
      memUsedMb: mean(present.map((p) => p.memUsedMb)),
      memPercent: mean(present.map((p) => p.memPercent)),
      latencyMs: mean(present.map((p) => p.latencyMs)),
      verdict: worstVerdict(present.map((p) => p.verdict)),
    };
  }

  return {
    t,
    host: {
      loadPercent: mean(samples.map((s) => s.host.loadPercent)),
      memPercent: mean(samples.map((s) => s.host.memPercent)),
      diskPercent: mean(samples.map((s) => s.host.diskPercent)),
    },
    instances,
  };
}

export interface MetricsHistoryOptions {
  /** 细档间隔，应与采样器一致，默认 10 秒 */
  fineStepSec?: number;
  /** 细档保留时长，默认 1 小时 */
  fineSpanSec?: number;
  /** 粗档间隔，默认 5 分钟 */
  coarseStepSec?: number;
  /** 粗档保留时长，默认 24 小时 */
  coarseSpanSec?: number;
}

export class MetricsHistory {
  readonly fineStepSec: number;
  readonly fineSpanSec: number;
  readonly coarseStepSec: number;
  readonly coarseSpanSec: number;

  private readonly fine: Ring<MetricSample>;
  private readonly coarse: Ring<MetricSample>;
  /** 正在攒的粗档桶。攒够一个间隔才落进粗档环 */
  private pending: { index: number; samples: MetricSample[] } | null = null;
  private first: number | null = null;

  constructor(options: MetricsHistoryOptions = {}) {
    this.fineStepSec = options.fineStepSec ?? 10;
    this.fineSpanSec = options.fineSpanSec ?? 3600;
    this.coarseStepSec = options.coarseStepSec ?? 300;
    this.coarseSpanSec = options.coarseSpanSec ?? 86400;
    this.fine = new Ring<MetricSample>(Math.ceil(this.fineSpanSec / this.fineStepSec));
    this.coarse = new Ring<MetricSample>(Math.ceil(this.coarseSpanSec / this.coarseStepSec));
  }

  /** 可查询的最长窗口 */
  get maxRangeSec(): number {
    return this.coarseSpanSec;
  }

  record(sample: MetricSample): void {
    this.fine.push(sample);
    if (this.first === null) this.first = sample.t;

    const stepMs = this.coarseStepSec * 1000;
    const index = Math.floor(sample.t / stepMs);
    if (this.pending && this.pending.index !== index) {
      this.coarse.push(aggregate(this.pending.samples, this.pending.index * stepMs));
      this.pending = null;
    }
    if (!this.pending) this.pending = { index, samples: [] };
    this.pending.samples.push(sample);
  }

  latest(): MetricSample | undefined {
    const arr = this.fine.toArray();
    return arr[arr.length - 1];
  }

  /**
   * 取一段窗口。窗口超过细档保留时长就自动降到粗档 ——
   * 界面不必知道两档的存在，只说「最近 N 小时」。
   */
  query(rangeSec: number, now = Date.now()): MetricsSeries {
    const useFine = rangeSec <= this.fineSpanSec;
    const from = now - rangeSec * 1000;
    // 粗档要带上正在攒的那个桶，否则 24 小时视图的末端会缺最近几分钟
    const source = useFine ? this.fine.toArray() : this.coarseWithPending();
    const points = source.filter((p) => p.t >= from);

    const ids = new Set<string>();
    for (const p of points) for (const id of Object.keys(p.instances)) ids.add(id);

    return {
      stepSec: useFine ? this.fineStepSec : this.coarseStepSec,
      from,
      to: now,
      firstSampleAt: this.first,
      points,
      instanceIds: [...ids].sort(),
    };
  }

  private coarseWithPending(): MetricSample[] {
    const arr = this.coarse.toArray();
    if (this.pending && this.pending.samples.length > 0) {
      arr.push(aggregate(this.pending.samples, this.pending.index * this.coarseStepSec * 1000));
    }
    return arr;
  }
}

/**
 * 按可见实例裁剪一段序列（T4.4）。
 *
 * 趋势接口是**聚合**接口：一次返回全部实例的曲线，guard 无从按实例拦 ——
 * 不裁剪就等于把未授权实例的名字、CPU、内存、状态一起端给了对方，
 * 这与「A 用户无法访问未授权实例的任何接口」是同一条红线。
 *
 * 宿主读数不裁：那是整机的，与实例授权无关，且看板上必须有它才能判断
 * 「是我这台实例的问题，还是机器已经压满了」。
 */
export function filterSeries(
  series: MetricsSeries,
  visible: 'all' | ReadonlySet<string>,
): MetricsSeries {
  if (visible === 'all') return series;
  return {
    ...series,
    points: series.points.map((p) => {
      const instances: Record<string, InstancePoint> = {};
      for (const [id, point] of Object.entries(p.instances)) {
        if (visible.has(id) && point) instances[id] = point;
      }
      return { ...p, instances };
    }),
    instanceIds: series.instanceIds.filter((id) => visible.has(id)),
  };
}

/** 采样器的数据来源。用结构类型而非依赖 InstanceService，测试可直接塞假的 */
export interface MetricsSource {
  hostStats(): Promise<HostStats>;
  healthAll(): Promise<InstanceHealth[]>;
}

/** 把一次三层探针的结果压成一个采样点 */
export async function collectSample(src: MetricsSource, now = Date.now()): Promise<MetricSample> {
  const [host, healths] = await Promise.all([src.hostStats(), src.healthAll()]);

  const instances: Record<string, InstancePoint> = {};
  for (const h of healths) {
    const used = h.container.memUsedMb;
    const limit = h.container.memLimitMb;
    instances[h.id] = {
      cpuPercent: h.container.cpuPercent,
      memUsedMb: used,
      memPercent: used !== null && limit ? Math.round((used / limit) * 1000) / 10 : null,
      // 探针不通时那个耗时是「失败用了多久」，不是延迟。记成 null 让曲线断开，
      // 否则超时的 5000ms 会被当成一次「很慢但成功」的请求，把图带偏
      latencyMs: h.app.ok ? h.app.latencyMs : null,
      verdict: h.verdict,
    };
  }

  return {
    t: now,
    host: {
      loadPercent: host.loadPercent,
      memPercent: host.memPercent,
      diskPercent: host.diskPercent,
    },
    instances,
  };
}

export interface MetricsSamplerOptions {
  history: MetricsHistory;
  source: MetricsSource;
  intervalMs: number;
  onError?: (e: unknown) => void;
}

/**
 * 后台采样器。
 *
 * 必须常驻后台、而不是「有人打开页面才采」：健康监测的意义正在于
 * **没人看的时候发生了什么**。等运维打开页面才开始记，出事那段永远是空白。
 */
export class MetricsSampler {
  private readonly o: MetricsSamplerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(options: MetricsSamplerOptions) {
    this.o = options;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs);
    // 采样不该拖着进程不退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 单次采样。返回是否真的记了一个点。
   *
   * 上一轮没跑完就跳过这一轮：探针比采样间隔慢时（实例多、docker stats 慢），
   * 排队会越堆越长，最后把 docker 压垮 —— 宁可少一个点。
   */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.o.history.record(await collectSample(this.o.source));
      return true;
    } catch (e) {
      this.o.onError?.(e);
      return false;
    } finally {
      this.busy = false;
    }
  }
}
