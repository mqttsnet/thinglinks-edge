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
  /**
   * 已发出但还没完成的批次上限（发送是串行的，超出的都在排队）。
   *
   * 没有这条上限时，云端**慢**（不是断——断了会立刻抛错落缓存，而是 TCP 卡住不回）
   * 会让批次在内存里无限排队：每一批最多 256KB，一个实例狂灌点位就能把
   * 共享的 Manager 内存吃穿，连带拖垮同机其它实例。
   */
  maxQueuedBatches: number;
  /** 排队批次的字节上限，与条数上限谁先到算谁 */
  maxQueuedBytes: number;
}

/*
 * ── 三个阈值的实测依据（2026-08-28）──
 *
 * **maxPoints 从 500 提到 2000。** 实测分组后一个点只有约 19 字节，
 * 500 点的报文才 9.3 KB —— 而字节预算是 256 KB，利用率 3.6%。
 * 点数限制卡得远早于字节限制，白白把上行切成小包。上行是串行的
 * （QoS 1 等 PUBACK），批次越小、往返次数越多，吞吐直接被 RTT 除。
 * 实测：RTT 200ms 下 500 点/批约 2250 点/秒，2000 点/批约 9000 点/秒。
 *
 * **maxBytes 保持 256 KB，但它的实际含义与字面不同 —— 改之前务必读完。**
 *
 * 两个反向偏差恰好抵消：
 *
 *   · `#bytes` 累加的是**分组前**的单点，而 `groupPoints` 会把同一设备同一
 *     serviceCode 同一 eventTime 的点合并 —— 实测高估约 4.9 倍
 *   · `dataBody` 加密后是小写 HEX 字符串，**整包放大 2.0 倍**（实测）
 *
 * 净效果：`#bytes` 触到 256 KB 时，真实明文约 52 KB，加密后上线约 105 KB。
 *
 * **所以不要单独「修好」那个高估。** 只把 `#bytes` 改成按分组后计算，
 * 会让实际报文从 105 KB 一路涨到 512 KB —— 而 BifroMQ 的
 * `MaxUserPayloadBytes` 走内核默认（本插件没覆盖它），超了会被拒或断连，
 * 且这种故障只在**大批量+加密**同时出现时才复现，最难查。
 * 真要改，两处必须一起算，并先确认 broker 的实际上限。
 *
 * **另一条天花板：BifroMQ 限制单客户端 `msgPubPerSec`（默认 200，3.3.5 上限 1000）。**
 * 实时上行与断网补传**共用同一个 MQTT 客户端**，两者加起来受这一个预算约束。
 * 当前串行发送下 RTT 5ms 才 162 次/秒，够不着；但将来若改成并发发送，
 * 1000 就是硬上限，必须留出实时通道的份额，并处理被限流的情况。
 */
export const DEFAULT_LIMITS: BatchLimits = {
  windowMs: 200,
  maxPoints: 2000,
  maxBytes: 256 * 1024,
  // 8 批 × 256KB ≈ 2MB 上限：够扛住一次网络抖动，又不至于把小盒子撑爆
  maxQueuedBatches: 8,
  maxQueuedBytes: 2 * 1024 * 1024,
};

/**
 * 队列满时 `add` 抛这个。
 *
 * 单独一个类型是为了让调用方能把它和「数据不合法」区分开：
 * 前者该回 503 让上游**稍后再来**，后者是 400 永远别再来了。
 */
export class BatchOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchOverflowError';
  }
}

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
  /** 已排队待发的批次数与字节数 —— 队列的水位，满了就拒收 */
  #queued = 0;
  #queuedBytes = 0;
  #rejected = 0;
  #closed = false;

  constructor(options: MicroBatcherOptions) {
    this.#o = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  get pending(): number { return this.#buf.length; }
  get pendingBytes(): number { return this.#bytes; }
  /** 排队中的批次数（含正在发的那一批） */
  get queued(): number { return this.#queued; }
  get queuedBytes(): number { return this.#queuedBytes; }
  /** 被拒收的点位累计数。看板上要看得见，否则「数据少了」查不出原因 */
  get rejected(): number { return this.#rejected; }

  /**
   * 队列是否已满。调用方应当在收下一批数据**之前**问一次，
   * 好回一个明确的「稍后再来」，而不是等 add 抛错抛到一半。
   */
  get saturated(): boolean {
    return this.#queued >= this.limits.maxQueuedBatches
      || this.#queuedBytes >= this.limits.maxQueuedBytes;
  }

  /**
   * 入队一个点位。
   *
   * 字节数按单点序列化长度累加 —— 分组合并后实际报文只会更小，
   * 这个估算偏保守，宁可早发一批也不要超过云侧限制。
   */
  add(point: UplinkPoint): void {
    if (this.#closed) throw new Error('批处理器已关闭');
    /*
     * 满了就**拒收并计数**，不排队也不静默丢。
     *
     * 静默丢是最糟的选项：现场看到的是「数据少了几段」，而系统一切正常。
     * 拒收让上游立刻知道发不进去，它可以自己缓存或降采样；
     * 计数则让看板上能看见到底丢了多少。
     */
    if (this.saturated) {
      this.#rejected += 1;
      throw new BatchOverflowError(
        `上行队列已满（${this.#queued} 批 / ${this.#queuedBytes} 字节），云端发送跟不上`,
      );
    }
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
    const bytes = this.#bytes;
    this.#buf = [];
    this.#bytes = 0;

    this.#queued += 1;
    this.#queuedBytes += bytes;
    this.#chain = this.#chain.then(async () => {
      try {
        await this.#o.flush(groupPoints(points), points);
      } catch (e) {
        this.#o.onFlushError?.(e as Error, points);
      } finally {
        // 水位必须在 finally 里退，否则 flush 抛错就再也降不下来，队列永久假满
        this.#queued -= 1;
        this.#queuedBytes -= bytes;
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
