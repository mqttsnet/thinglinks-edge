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
  #closed = false;

  private constructor(opts: SegmentLogOptions) {
    this.dir = opts.dir;
    this.maxSegmentBytes = opts.maxSegmentBytes ?? 64 * 1024 * 1024;
    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
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
      void this.flush();
    }, this.flushIntervalMs);
    this.#flushTimer.unref?.();
  }

  /** 立刻落盘 */
  async flush(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    await this.#handle?.sync().catch(() => undefined);
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
