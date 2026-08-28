/**
 * append-only 分段日志 —— 断网缓存的载体（08 号文第 3 节）。
 *
 * 为什么不用 SQLite：缓存的访问模式是**纯顺序写 + 纯顺序读 + 整段删除**，
 * 用不到 SQL 的任何能力；而 SQLite 单写者 + 每事务 fsync 在高频写入下放大严重。
 * 断网 1 小时按 1.4k 点/秒估算约 500 万条，存得下但写入吞吐与磁盘寿命都是问题。
 *
 * 记录格式（8 字节头 + 载荷）：
 *
 *     [u32 载荷长度][u32 载荷 CRC32][载荷]
 *
 * 长度与校验都要：只有长度时，尾部残缺记录可能恰好长度合法而内容是垃圾；
 * 只有校验时，无法知道该读多少字节。
 */
import { open, readdir, mkdir, unlink, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const HEADER = 8;
const SEG_EXT = '.seg';
/**
 * 刷盘连续失败时的退避上限。
 *
 * 磁盘真坏了会一直失败，按正常间隔重试等于每 200ms 刷一条告警日志 ——
 * 噪音会把真正有用的信息淹掉。退避到 30 秒既保住「恢复后能自愈」，
 * 又不至于刷屏。
 */
const MAX_FLUSH_BACKOFF_MS = 30_000;
/** 段文件名固定 8 位十进制，保证字典序等于数值序 */
const segName = (id: number) => String(id).padStart(8, '0') + SEG_EXT;

export interface SegmentLogOptions {
  dir: string;
  /** 单段上限，默认 64 MB */
  maxSegmentBytes?: number;
  /**
   * 刷盘间隔（毫秒），默认 200。
   * 每条都 fsync 会毁掉吞吐与磁盘寿命；掉电最多丢这段时间的数据，
   * 对边缘采集是可接受的取舍 —— 但必须是**明示**的取舍，不能默默不刷。
   */
  flushIntervalMs?: number;
  /**
   * 刷盘失败回调。
   *
   * **必须有人接住。** 定时刷盘是 fire-and-forget 的，fsync 失败没有调用方能
   * catch；早先这里写的是 `.catch(() => undefined)`，于是磁盘故障时刷盘静默失败，
   * 而 spool 照常报告「数据已存」—— 那是最坏的一种谎报：
   * 界面一切正常，数据其实没落盘。
   */
  onFlushError?: (e: Error) => void;
  /**
   * 注入 fsync 实现，**仅测试用**。
   *
   * 需要它是因为「刷盘失败」在真实文件系统上很难确定性复现：
   * 删目录、改权限都挡不住已打开的 fd（POSIX 语义，inode 活到 fd 关闭）。
   * 没有这个注入口，相关测试只能靠时序碰运气 —— 那种测试比没有更糟。
   * 与 MicroBatcher 的 setTimer / CloudGateway 的 connectFn 是同一类做法。
   */
  fsyncFn?: (handle: FileHandle) => Promise<void>;
}

export interface RecordRef {
  segment: number;
  /** 记录**头部**在段内的字节偏移 */
  offset: number;
}

export interface SpoolRecord extends RecordRef {
  payload: Buffer;
  /** 该记录之后的偏移，用于记录消费进度 */
  nextOffset: number;
}

export class SegmentLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentLogError';
  }
}

export class SegmentLog {
  readonly dir: string;
  readonly maxSegmentBytes: number;
  readonly flushIntervalMs: number;

  #handle: FileHandle | undefined;
  #currentId = 0;
  #currentBytes = 0;
  #segments: number[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #dirty = false;
  #flushTimer: NodeJS.Timeout | undefined;
  #lastFlushError: string | undefined;
  readonly #onFlushError: ((e: Error) => void) | undefined;
  readonly #fsync: (h: FileHandle) => Promise<void>;
  /** 连续刷盘失败时的退避间隔；成功一次即归零。0 表示用正常间隔 */
  #flushBackoff = 0;
  #closed = false;

  private constructor(opts: SegmentLogOptions) {
    this.dir = opts.dir;
    this.maxSegmentBytes = opts.maxSegmentBytes ?? 64 * 1024 * 1024;
    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
    this.#onFlushError = opts.onFlushError;
    this.#fsync = opts.fsyncFn ?? ((h) => h.sync());
  }

  static async open(opts: SegmentLogOptions): Promise<SegmentLog> {
    const log = new SegmentLog(opts);
    await mkdir(log.dir, { recursive: true });
    const files = await readdir(log.dir);
    log.#segments = files
      .filter((f) => f.endsWith(SEG_EXT))
      .map((f) => Number(f.slice(0, -SEG_EXT.length)))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);

    if (log.#segments.length === 0) {
      log.#currentId = 1;
      log.#segments = [1];
      log.#currentBytes = 0;
    } else {
      log.#currentId = log.#segments[log.#segments.length - 1]!;
      // 崩溃恢复：最后一段的尾部残缺记录必须截掉，否则读到一半就炸
      log.#currentBytes = await log.#truncatePartial(log.#currentId);
    }
    log.#handle = await open(log.#path(log.#currentId), 'a+');
    return log;
  }

  #path(id: number): string { return join(this.dir, segName(id)); }

  /** 扫一遍段文件，返回最后一条**完整**记录之后的偏移，并把尾部残缺截掉 */
  async #truncatePartial(id: number): Promise<number> {
    const path = this.#path(id);
    const fh = await open(path, 'r+');
    try {
      const size = (await fh.stat()).size;
      let off = 0;
      const head = Buffer.alloc(HEADER);
      for (;;) {
        if (off + HEADER > size) break;
        const { bytesRead } = await fh.read(head, 0, HEADER, off);
        if (bytesRead < HEADER) break;
        const len = head.readUInt32BE(0);
        const expect = head.readUInt32BE(4);
        if (off + HEADER + len > size) break;              // 载荷没写完
        const body = Buffer.alloc(len);
        await fh.read(body, 0, len, off + HEADER);
        if (crc32(body) !== expect) break;                  // 内容坏了，从这里截断
        off += HEADER + len;
      }
      if (off !== size) await fh.truncate(off);
      return off;
    } finally {
      await fh.close();
    }
  }

  get segments(): number[] { return [...this.#segments]; }
  get currentSegment(): number { return this.#currentId; }

  /** 全部段占用的字节数 */
  async totalBytes(): Promise<number> {
    let sum = 0;
    for (const id of this.#segments) {
      sum += await stat(this.#path(id)).then((s) => s.size).catch(() => 0);
    }
    return sum;
  }

  /** 追加一条记录。串行执行，返回它的位置 */
  append(payload: Buffer): Promise<RecordRef> {
    if (this.#closed) return Promise.reject(new SegmentLogError('日志已关闭'));
    const task = this.#chain.then(async () => {
      if (this.#currentBytes > 0 && this.#currentBytes + HEADER + payload.length > this.maxSegmentBytes) {
        await this.#roll();
      }
      const head = Buffer.alloc(HEADER);
      head.writeUInt32BE(payload.length, 0);
      head.writeUInt32BE(crc32(payload), 4);
      const at = this.#currentBytes;
      await this.#handle!.write(Buffer.concat([head, payload]), 0, HEADER + payload.length, at);
      this.#currentBytes += HEADER + payload.length;
      this.#scheduleFlush();
      return { segment: this.#currentId, offset: at };
    });
    this.#chain = task.catch(() => undefined);
    return task;
  }

  async #roll(): Promise<void> {
    await this.#handle?.sync();
    await this.#handle?.close();
    this.#currentId += 1;
    this.#segments.push(this.#currentId);
    this.#currentBytes = 0;
    this.#handle = await open(this.#path(this.#currentId), 'a+');
  }

  #scheduleFlush(): void {
    this.#dirty = true;
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      /*
       * 定时刷盘没有调用方能 catch，所以失败一律交给 onFlushError。
       * 没配回调时至少打一条 error 日志 —— 绝不静默吞掉。
       */
      this.flush().then(
        () => { this.#flushBackoff = 0; },
        (e: Error) => {
          if (this.#onFlushError) this.#onFlushError(e);
          else console.error(`[alarm] 断网缓存刷盘失败：${e.message}`);
          /*
           * **必须显式重排**。`flush()` 失败时会重新标脏，但标脏本身不会
           * 排定时器 —— 只有 append 才会。不重排的话，磁盘临时故障之后
           * 这批数据就再也不会被尝试刷盘了，哪怕磁盘马上恢复。
           * 这个 bug 是被「刷盘失败后会重试」那条测试当场抓出来的。
           */
          this.#flushBackoff = Math.min(
            this.#flushBackoff === 0 ? this.flushIntervalMs : this.#flushBackoff * 2,
            MAX_FLUSH_BACKOFF_MS,
          );
          this.#scheduleFlush();
        },
      );
    }, this.#flushBackoff || this.flushIntervalMs);
    this.#flushTimer.unref?.();
  }

  /**
   * 立刻落盘。
   *
   * 失败时**重新标记为脏**并抛出：下一个刷盘周期会再试，而调用方（或
   * onFlushError）能知道这次没成。不重新标脏的话，一次失败之后这批数据
   * 就再也不会被尝试刷盘了。
   */
  async flush(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      if (this.#handle) await this.#fsync(this.#handle);
      this.#lastFlushError = undefined;
    } catch (e) {
      this.#dirty = true;
      this.#lastFlushError = (e as Error).message;
      throw e;
    }
  }

  /** 最近一次刷盘失败的原因，供指标与诊断包展示；成功一次即清空 */
  get lastFlushError(): string | undefined {
    return this.#lastFlushError;
  }

  /**
   * 从指定位置起顺序读。不给起点则从最旧的段开头读。
   *
   * 读到坏记录就**停在那里**而不是跳过：分段日志是顺序结构，
   * 跳过一条坏记录之后的偏移全是猜的，只会读出更多垃圾。
   */
  async *read(from?: RecordRef): AsyncGenerator<SpoolRecord> {
    const startSeg = from?.segment ?? this.#segments[0] ?? this.#currentId;
    for (const id of this.#segments) {
      if (id < startSeg) continue;
      let off = id === startSeg ? (from?.offset ?? 0) : 0;
      let fh: FileHandle;
      try {
        fh = await open(this.#path(id), 'r');
      } catch {
        continue;                                            // 段已被回收
      }
      try {
        const size = (await fh.stat()).size;
        const head = Buffer.alloc(HEADER);
        while (off + HEADER <= size) {
          const { bytesRead } = await fh.read(head, 0, HEADER, off);
          if (bytesRead < HEADER) break;
          const len = head.readUInt32BE(0);
          const expect = head.readUInt32BE(4);
          if (off + HEADER + len > size) break;
          const body = Buffer.alloc(len);
          await fh.read(body, 0, len, off + HEADER);
          if (crc32(body) !== expect) break;
          yield { segment: id, offset: off, payload: body, nextOffset: off + HEADER + len };
          off += HEADER + len;
        }
      } finally {
        await fh.close();
      }
    }
  }

  /** 整段回收。当前正在写的段不允许删 */
  async removeSegment(id: number): Promise<void> {
    if (id === this.#currentId) throw new SegmentLogError(`段 ${id} 正在写入，不能回收`);
    await unlink(this.#path(id)).catch(() => undefined);
    this.#segments = this.#segments.filter((s) => s !== id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    await this.#chain.catch(() => undefined);
    await this.#handle?.sync().catch(() => undefined);
    await this.#handle?.close().catch(() => undefined);
    this.#handle = undefined;
  }
}
