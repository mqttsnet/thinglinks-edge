/**
 * 断网缓存与补传（08 号文第 3、6、7 节）。
 *
 * 三件事在这里合流：
 *   · **缓存**：写不出去的批次落进分段日志，等链路恢复
 *   · **补传**：按段顺序重放，整段传完即回收文件
 *   · **写满策略**：丢最旧 / 丢最新 / 停止采集 —— 这是**业务决策**，
 *     不由产品替客户决定（原型早期写死「丢最旧」，是错的）
 *
 * 补传进度落在 spool 目录自己的 `index.db` 里，与主库分开：
 * 缓存目录因此是自描述的，可以整体搬走或单独排查。
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SegmentLog, type RecordRef } from './segment-log.ts';

/** 写满时的处置方式。没有「默认正确」的选项，必须显式配置 */
export type FullPolicy = 'drop-oldest' | 'drop-newest' | 'stop-accepting';

export type EnqueueResult = 'stored' | 'dropped-oldest' | 'dropped-newest' | 'rejected';

export interface SpoolOptions {
  dir: string;
  /** 缓存上限（字节），默认 2 GB */
  maxBytes?: number;
  /** 写满策略，默认丢最旧 —— 但部署时必须显式确认，见类注释 */
  fullPolicy?: FullPolicy;
  maxSegmentBytes?: number;
  flushIntervalMs?: number;
  /**
   * 写满告警。**只在进入/离开写满状态时各触发一次**，
   * 不是每条都告警 —— 断网时每秒上千条，逐条告警等于把告警系统打死。
   */
  onFull?: (info: { policy: FullPolicy; bytes: number; maxBytes: number; full: boolean }) => void;
  /**
   * 落盘失败告警。
   *
   * 与 `onFull` 是**两件不同的事**，早先只有前者，于是出现了一个很难看的不对称：
   * 「逻辑写满」（超过 maxBytes）会告警加审计，而「物理写不进去」
   * （ENOSPC、磁盘故障、权限）反而悄无声息 —— 后者明明更严重。
   *
   * `phase` 区分是写记录时失败还是 fsync 时失败：前者这条数据没进去，
   * 后者数据在页缓存里但没落盘，掉电就没了。两种都要报，处置方式不同。
   */
  onWriteError?: (info: { phase: 'append' | 'flush'; error: string }) => void;
  /** 注入 fsync，仅测试用；转交 SegmentLog，理由见那边的说明 */
  fsyncFn?: (handle: import('node:fs/promises').FileHandle) => Promise<void>;
}

export interface SpoolMetrics {
  /** 待补传条数（估算：按段内记录数累计） */
  pending: number;
  bytes: number;
  maxBytes: number;
  usagePercent: number;
  full: boolean;
  policy: FullPolicy;
  segments: number;
  droppedOldest: number;
  droppedNewest: number;
  rejected: number;
  replayed: number;
  /** 最近一次刷盘失败原因；空串表示落盘正常 */
  lastFlushError: string;
}

export class Spool {
  readonly dir: string;
  readonly maxBytes: number;
  readonly policy: FullPolicy;

  #log: SegmentLog;
  #db: Database.Database;
  #o: SpoolOptions;
  #full = false;
  #stats = { pending: 0, droppedOldest: 0, droppedNewest: 0, rejected: 0, replayed: 0 };

  private constructor(opts: SpoolOptions, log: SegmentLog, db: Database.Database) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.policy = opts.fullPolicy ?? 'drop-oldest';
    this.#o = opts;
    this.#log = log;
    this.#db = db;
  }

  static async open(opts: SpoolOptions): Promise<Spool> {
    mkdirSync(opts.dir, { recursive: true });
    const log = await SegmentLog.open({
      dir: opts.dir,
      ...(opts.maxSegmentBytes === undefined ? {} : { maxSegmentBytes: opts.maxSegmentBytes }),
      ...(opts.flushIntervalMs === undefined ? {} : { flushIntervalMs: opts.flushIntervalMs }),
      // 定时刷盘没有调用方能 catch，必须由这里转成告警
      onFlushError: (e) => opts.onWriteError?.({ phase: 'flush', error: e.message }),
      ...(opts.fsyncFn === undefined ? {} : { fsyncFn: opts.fsyncFn }),
    });
    const db = new Database(join(opts.dir, 'index.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY CHECK (id = 1), segment INTEGER NOT NULL, offset INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY, value INTEGER NOT NULL)`);

    const spool = new Spool(opts, log, db);
    spool.#stats.pending = spool.#countPending();
    return spool;
  }

  /** 下一条待补传记录的位置；没有进度时从最旧的段开头开始 */
  #progress(): RecordRef | undefined {
    const row = this.#db.prepare('SELECT segment, offset FROM progress WHERE id = 1').get() as
      { segment: number; offset: number } | undefined;
    return row ? { segment: row.segment, offset: row.offset } : undefined;
  }

  #setProgress(ref: RecordRef): void {
    this.#db.prepare(
      `INSERT INTO progress (id, segment, offset) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET segment = excluded.segment, offset = excluded.offset`,
    ).run(ref.segment, ref.offset);
  }

  #countPending(): number {
    const row = this.#db.prepare("SELECT value FROM counters WHERE name = 'pending'").get() as
      { value: number } | undefined;
    return row?.value ?? 0;
  }

  #bumpPending(delta: number): void {
    this.#stats.pending = Math.max(0, this.#stats.pending + delta);
    this.#db.prepare(
      `INSERT INTO counters (name, value) VALUES ('pending', ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    ).run(this.#stats.pending);
  }

  #signalFull(full: boolean, bytes: number): void {
    if (full === this.#full) return;                 // 只在状态翻转时告警
    this.#full = full;
    this.#o.onFull?.({ policy: this.policy, bytes, maxBytes: this.maxBytes, full });
  }

  /**
   * 入队一条待发数据。
   *
   * 写满时按配置的策略处置，并**产生一次告警**。返回值告诉调用方到底发生了什么 ——
   * 静默丢弃是这套机制里最不能接受的行为。
   */
  async enqueue(payload: unknown): Promise<EnqueueResult> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    let bytes = await this.#log.totalBytes();

    if (bytes + body.length > this.maxBytes) {
      this.#signalFull(true, bytes);
      if (this.policy === 'drop-newest') {
        this.#stats.droppedNewest += 1;
        return 'dropped-newest';
      }
      if (this.policy === 'stop-accepting') {
        this.#stats.rejected += 1;
        return 'rejected';
      }
      /*
       * drop-oldest：**循环**回收最旧的整段直到腾出空间。
       * 只丢一段是不够的 —— 一段的大小与所需空间没有任何关系，实测会超限。
       *
       * 当前写入段不能删，因此占用的真实上限是 `maxBytes + 一个段大小`。
       * 这是分段结构的固有代价：要更紧的上限就得把段调小，代价是段文件数量变多。
       */
      for (;;) {
        const oldest = this.#log.segments.find((s) => s !== this.#log.currentSegment);
        if (oldest === undefined) break;
        await this.#dropSegment(oldest);
        bytes = await this.#log.totalBytes();
        if (bytes + body.length <= this.maxBytes) break;
      }
    } else if (bytes + body.length <= this.maxBytes * 0.9) {
      this.#signalFull(false, bytes);
    }

    try {
      await this.#log.append(body);
    } catch (e) {
      /*
       * 写不进去就是**丢数据**。告警之后照样抛 —— 上层要据此知道这一批没保住，
       * 不能因为「已经告警过了」就把异常吞掉当成功。
       */
      this.#o.onWriteError?.({ phase: 'append', error: (e as Error).message });
      throw e;
    }
    this.#bumpPending(1);
    return 'stored';
  }

  /** 丢掉一整段。若补传进度还指向它，进度要跟着前移，否则会读到已删的段 */
  async #dropSegment(id: number): Promise<void> {
    let dropped = 0;
    for await (const r of this.#log.read({ segment: id, offset: 0 })) {
      if (r.segment !== id) break;
      dropped += 1;
    }
    await this.#log.removeSegment(id);
    this.#stats.droppedOldest += dropped;
    this.#bumpPending(-dropped);
    const p = this.#progress();
    if (p && p.segment <= id) {
      const next = this.#log.segments.find((s) => s > id);
      if (next !== undefined) this.#setProgress({ segment: next, offset: 0 });
    }
  }

  /**
   * 补传。
   *
   * 逐条发送并在**每条成功后**推进进度 —— 中途断掉时不会重发已确认的部分，
   * 也不会漏掉未确认的。整段传完即回收文件。
   *
   * `ratePerSec` 用于给补传限速：补传若全速发送会与实时数据争带宽（08 号文第 6 节）。
   */
  async replay(
    send: (payload: unknown) => Promise<void>,
    opts: { ratePerSec?: number; maxRecords?: number } = {},
  ): Promise<{ sent: number; failed: number }> {
    const gap = opts.ratePerSec && opts.ratePerSec > 0 ? 1000 / opts.ratePerSec : 0;
    let sent = 0;
    let failed = 0;
    let lastSegment: number | undefined;

    for await (const rec of this.#log.read(this.#progress())) {
      if (opts.maxRecords !== undefined && sent >= opts.maxRecords) break;
      try {
        await send(JSON.parse(rec.payload.toString('utf8')));
      } catch {
        failed += 1;
        break;                                       // 链路又断了，保住进度等下次
      }
      this.#setProgress({ segment: rec.segment, offset: rec.nextOffset });
      this.#bumpPending(-1);
      this.#stats.replayed += 1;
      sent += 1;

      // 跨到新段说明上一段已整段传完，可以回收
      if (lastSegment !== undefined && rec.segment !== lastSegment) {
        await this.#log.removeSegment(lastSegment).catch(() => undefined);
      }
      lastSegment = rec.segment;

      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    return { sent, failed };
  }

  async metrics(): Promise<SpoolMetrics> {
    const bytes = await this.#log.totalBytes();
    return {
      pending: this.#stats.pending,
      bytes,
      maxBytes: this.maxBytes,
      usagePercent: this.maxBytes === 0 ? 0 : Math.round((bytes / this.maxBytes) * 1000) / 10,
      full: this.#full,
      policy: this.policy,
      segments: this.#log.segments.length,
      droppedOldest: this.#stats.droppedOldest,
      droppedNewest: this.#stats.droppedNewest,
      rejected: this.#stats.rejected,
      /** 最近一次刷盘失败原因，空表示落盘正常。诊断包与控制台据此判断磁盘健康 */
      lastFlushError: this.#log.lastFlushError ?? '',
      replayed: this.#stats.replayed,
    };
  }

  async close(): Promise<void> {
    await this.#log.close();
    this.#db.close();
  }
}
