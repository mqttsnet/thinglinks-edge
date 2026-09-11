/**
 * 补传调度（T5.x 修补）。
 *
 * 这个模块存在的理由是一个**真实的漏洞**：补传原先只在「微批发送成功之后」
 * 触发一次，没有定时器、也没挂在链路恢复事件上。后果是——
 *
 *   断网期间攒下积压 → 链路恢复 → **如果现场此刻没有新数据上报，积压永远不补**
 *
 * 实测复现：恢复后等 3 秒 pending 仍是 3，直到来了一条新数据才补完。
 * 现场会踩到的场景不少：夜班停机、长周期抄读（15 分钟一次的电表）、
 * 断网期间实例本身也被停了。而界面上显示「已连接」，没有任何异常。
 *
 * 所以补传要有三个触发口，缺一不可：
 *
 *   1. **发送成功之后** —— 链路刚证明可用，趁势追欠账。实时数据天然优先
 *      （它先发），补传拿的是剩下的余量，优先级关系由顺序保证
 *   2. **链路恢复的那一刻** —— 不必等下一条业务数据
 *   3. **低频定时兜底** —— 前两条都没发生时的最后一道保险。
 *      频率刻意压得很低：它是兜底，不是主路径
 */
import type { Spool } from './spool.ts';

export interface DrainerOptions {
  spool: Spool;
  /** 把一批数据送出去；抛错表示链路还没好，本轮就此打住 */
  send: (payload: unknown) => Promise<void>;
  /** 链路当前可用吗。不可用时连试都不试，省得每次都白跑一遍 */
  ready: () => boolean;
  /** 补传限速，条/秒。默认 50 —— 补传不该与实时数据抢带宽 */
  ratePerSec?: number;
  /** 单轮上限，默认 200。避免一次性把积压全冲出去压垮云端 */
  maxRecords?: number;
  /**
   * 定时兜底间隔，默认 60 秒。**不要调小**：它只是保险，
   * 正常情况下补传由前两个触发口带动，定时器每分钟空跑一次的成本可以忽略。
   */
  intervalMs?: number;
  /** 每轮结果回调，用于记录指标与日志 */
  onRound?: (r: { sent: number; failed: number; trigger: DrainTrigger; elapsedMs: number }) => void;
}

/** 这一轮补传是被什么触发的 —— 排障时「为什么补了/为什么没补」全靠它 */
export type DrainTrigger = 'after-send' | 'link-online' | 'interval' | 'manual';

/**
 * 速率样本窗口。
 *
 * 太短会被单轮抖动带偏（一轮碰上云端慢响应，eta 就翻几倍）；
 * 太长则链路变好之后半天反应不过来。5 轮是个折中。
 */
const RATE_WINDOW = 5;

/**
 * 一轮补传的结果。
 *
 * 写成具名接口而不是 `typeof this.#lastRound` —— 测试经
 * `node --experimental-strip-types` 纯剥离运行，那种写法它解析不了
 * （报 `Expected ident`）。与「不用 TS 参数属性」是同一类约束。
 */
export interface DrainRound {
  at: string;
  sent: number;
  failed: number;
  trigger: DrainTrigger;
  /** 本轮耗时，用于算速率 */
  elapsedMs: number;
}

/**
 * 补传进度估计（08 号文第 8 节要求「补传进度与预计完成」）。
 *
 * **宁可说不知道，也不编一个数**。现场看到「预计 3 分钟」然后等了半小时，
 * 下次就再也不信这个读数了 —— 一个不可信的估计比没有估计更糟。
 * 所以速率样本不足、链路没通、根本没在补的时候，`etaSec` 一律是 null，
 * 并由 `reason` 说清为什么没有。
 */
export interface DrainProgress {
  /** 待补传条数 */
  pending: number;
  /** 实测补传速率（条/秒）。样本不足时为 null */
  ratePerSec: number | null;
  /** 预计剩余秒数。算不出来时为 null —— 不猜 */
  etaSec: number | null;
  /** 当前是否有一轮在跑 */
  running: boolean;
  /** 没有 eta 时说明原因；有 eta 时为空串 */
  reason: string;
}

export class SpoolDrainer {
  #o: DrainerOptions;
  /** 单飞：多个触发口可能同时到，但同一时刻只允许一轮在跑 */
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #lastRound: DrainRound | undefined;
  /** 最近几轮的实测速率样本，滑动窗口 */
  #samples: Array<{ sent: number; elapsedMs: number }> = [];

  constructor(options: DrainerOptions) {
    this.#o = options;
  }

  /**
   * 触发一轮补传。
   *
   * 并发调用是安全的：已经在跑就直接返回，不排队也不叠加 ——
   * 排队会让「链路恢复瞬间涌进来的多个触发」变成连着跑好几轮，
   * 正好把刚恢复的链路再压垮一次。
   */
  async trigger(
    trigger: DrainTrigger = 'manual',
    /**
     * 单次覆盖限速与条数。给「现场手动补传」用：那是人盯着的操作，
     * 可以比后台自动补传激进一些。**但必须走同一个单飞闸门** ——
     * 手动接口早先直接调 `spool.replay`，与自动补传并发跑时两边从同一个
     * 进度开始读，会重复发送并把 pending 计数搞乱。
     */
    opts: { ratePerSec?: number; maxRecords?: number } = {},
  ): Promise<{ sent: number; failed: number }> {
    if (this.#running || !this.#o.ready()) return { sent: 0, failed: 0 };
    this.#running = true;
    const startedAt = Date.now();
    try {
      const r = await this.#o.spool.replay(
        async (p) => { await this.#o.send(p); },
        {
          ratePerSec: opts.ratePerSec ?? this.#o.ratePerSec ?? 50,
          maxRecords: opts.maxRecords ?? this.#o.maxRecords ?? 200,
        },
      );
      if (r.sent > 0 || r.failed > 0) {
        const elapsedMs = Date.now() - startedAt;
        this.#lastRound = { at: new Date().toISOString(), ...r, trigger, elapsedMs };
        // 只有真发出去东西的轮次才计入速率：空轮的耗时接近 0，会把速率算到天上
        if (r.sent > 0 && elapsedMs > 0) {
          this.#samples.push({ sent: r.sent, elapsedMs });
          if (this.#samples.length > RATE_WINDOW) this.#samples.shift();
        }
        this.#o.onRound?.({ ...r, trigger, elapsedMs });
      }
      return r;
    } catch {
      // 补传本身抛错（比如缓存目录读不了）不该把调用方带崩：
      // 它是后台任务，失败下一轮再试
      return { sent: 0, failed: 0 };
    } finally {
      this.#running = false;
    }
  }

  /** 启动定时兜底。重复调用只保留一个定时器 */
  start(): void {
    if (this.#timer !== undefined) return;
    const ms = this.#o.intervalMs ?? 60_000;
    this.#timer = setInterval(() => { void this.trigger('interval'); }, ms);
    // unref：这个定时器不该拖着进程不让退出
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 最近一轮补传的结果，供控制台展示「补传是否在推进」 */
  get lastRound(): DrainRound | undefined {
    return this.#lastRound;
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * 补传进度与预计完成时间。
   *
   * 速率取最近若干轮的**实测值**，不是配置里的限速 —— 限速是上限，
   * 真实速率还受云端响应、网络、单轮上限影响，用配置值算出来的 eta 会偏乐观。
   */
  progress(pending: number): DrainProgress {
    const base = { pending, running: this.#running };
    if (pending <= 0) {
      return { ...base, ratePerSec: null, etaSec: null, reason: '没有待补传数据' };
    }
    if (!this.#o.ready()) {
      return { ...base, ratePerSec: null, etaSec: null, reason: '链路未恢复，补传尚未开始' };
    }
    if (this.#samples.length === 0) {
      return { ...base, ratePerSec: null, etaSec: null, reason: '还没有补传样本，无法估计' };
    }
    const sent = this.#samples.reduce((a, s) => a + s.sent, 0);
    const ms = this.#samples.reduce((a, s) => a + s.elapsedMs, 0);
    const rate = ms > 0 ? (sent * 1000) / ms : 0;
    if (rate <= 0) {
      return { ...base, ratePerSec: null, etaSec: null, reason: '补传速率为零，无法估计' };
    }
    return { ...base, ratePerSec: Math.round(rate * 10) / 10,
             etaSec: Math.ceil(pending / rate), reason: '' };
  }
}
