/**
 * 微批聚合 —— 高并发得以成立的根本（08 号文第 2 节）。
 *
 * 云侧 datas 载荷原生支持一条消息携带**多个子设备 x 多个服务**
 * （实读 TopoDeviceDataReportParam）。1.4k 点/秒的现场负载聚合后约 5 条消息/秒，
 * 消息数下降两个数量级。
 *
 * 三个触发条件任一满足即发送：时间窗 200ms、条数 500、字节数 256KB。
 *
 * 时间戳在**入队时**打，不是发送时（08 号文第 5 节）——
 * 否则断网补传的数据会带上错误的时间序，云侧按 eventTime 排出来的顺序就是错的。
 */

export interface UplinkPoint {
  /** 子设备标识；网关自身的数据用网关标识 */
  deviceId: string;
  serviceCode: string;
  data: Record<string, unknown>;
  /** epoch 毫秒，入队时打 */
  eventTime: number;
}

/** 云侧 datas 载荷结构，字段名逐个对齐 TopoDeviceDataReportParam */
export interface DataReportPayload {
  devices: {
    deviceId: string;
    services: { serviceCode: string; data: Record<string, unknown>; eventTime: number }[];
  }[];
}

export interface BatchLimits {
  windowMs: number;
  maxPoints: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: BatchLimits = {
  windowMs: 200,
  maxPoints: 500,
  maxBytes: 256 * 1024,
};

export interface MicroBatcherOptions {
  limits?: Partial<BatchLimits>;
  /** 发送一批。抛错表示没发出去，由调用方决定入 spool 还是丢弃 */
  flush: (payload: DataReportPayload, points: UplinkPoint[]) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 发送失败时回调；不提供则吞掉（重试是 flush 实现方的事） */
  onFlushError?: (e: Error, points: UplinkPoint[]) => void;
}

/**
 * 把扁平的点位聚成云侧载荷。
 *
 * 同一 deviceId 归一台设备；设备内 serviceCode 与 eventTime **都相同**的点合并 data
 * （无损：它们本就属于同一次采集）。eventTime 不同的绝不合并 ——
 * 合并会把时间序抹平，而云侧正是按它排序。
 */
export function groupPoints(points: UplinkPoint[]): DataReportPayload {
  type Svc = { serviceCode: string; data: Record<string, unknown>; eventTime: number };
  const byDevice = new Map<string, Map<string, Svc>>();
  const order: string[] = [];

  for (const p of points) {
    let services = byDevice.get(p.deviceId);
    if (!services) {
      services = new Map();
      byDevice.set(p.deviceId, services);
      order.push(p.deviceId);
    }
    const key = p.serviceCode + '@' + p.eventTime;
    const existing = services.get(key);
    if (existing) Object.assign(existing.data, p.data);
    else services.set(key, { serviceCode: p.serviceCode, data: { ...p.data }, eventTime: p.eventTime });
  }

  return {
    devices: order.map((deviceId) => ({
      deviceId,
      services: [...byDevice.get(deviceId)!.values()],
    })),
  };
}

export class MicroBatcher {
  readonly limits: BatchLimits;
  #o: MicroBatcherOptions;
  #buf: UplinkPoint[] = [];
  #bytes = 0;
  #timer: unknown;
  /** 串行发送，避免乱序与并发压垮云端 */
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: MicroBatcherOptions) {
    this.#o = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  get pending(): number { return this.#buf.length; }
  get pendingBytes(): number { return this.#bytes; }

  /**
   * 入队一个点位。
   *
   * 字节数按单点序列化长度累加 —— 分组合并后实际报文只会更小，
   * 这个估算偏保守，宁可早发一批也不要超过云侧限制。
   */
  add(point: UplinkPoint): void {
    if (this.#closed) throw new Error('批处理器已关闭');
    this.#buf.push(point);
    this.#bytes += Buffer.byteLength(JSON.stringify(point), 'utf8');

    if (this.#buf.length >= this.limits.maxPoints || this.#bytes >= this.limits.maxBytes) {
      void this.flushNow();
      return;
    }
    // 时间窗从**本批第一个点**开始算。每来一个点就重置的话，
    // 持续来点会让定时器永远不触发，实时性上限就没了
    if (this.#timer === undefined) {
      const set = this.#o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      this.#timer = set(() => { void this.flushNow(); }, this.limits.windowMs);
    }
  }

  /** 立刻发出当前批次。串行排队，返回本批发送完成的 Promise */
  flushNow(): Promise<void> {
    this.#cancelTimer();
    if (this.#buf.length === 0) return this.#chain;

    const points = this.#buf;
    this.#buf = [];
    this.#bytes = 0;

    this.#chain = this.#chain.then(async () => {
      try {
        await this.#o.flush(groupPoints(points), points);
      } catch (e) {
        this.#o.onFlushError?.(e as Error, points);
      }
    });
    return this.#chain;
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    const clear = this.#o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    clear(this.#timer);
    this.#timer = undefined;
  }

  /** 关闭前把手里的点发完，不静默丢弃 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.flushNow();
    this.#cancelTimer();
  }
}
