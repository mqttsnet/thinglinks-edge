/**
 * Docker 日志流解帧。
 *
 * 实例容器以 `Tty:false` 创建（container-spec 从不设 Tty，Docker 默认即 false），
 * 因此 `/containers/{id}/logs` 返回的是**多路复用流**：每次写入前置 8 字节帧头 ——
 * 字节 0 是流别（0=stdin / 1=stdout / 2=stderr），字节 1~3 恒为 0，
 * 字节 4~7 是大端 uint32 载荷长度。
 *
 * 直接 `buf.toString('utf8')` 会把帧头当正文，输出里混入 NUL 与控制字节：
 *
 *     0100 0000 0000 000d 4845 4c4c 4f2d 5354   ........HELLO-ST
 *
 * 这个缺陷没有症状 —— 日志「看起来有内容」，只是每个写入块开头多几个不可见字节，
 * 而且 stdout 与 stderr 分不开。
 *
 * `Tty:true` 时 Docker 不加帧头、直接回原始字节。此处做格式探测并回退，
 * 避免将来有人打开 Tty 时正文被当帧头吃掉。
 */

import { TextDecoder } from 'node:util';

/** 帧头固定 8 字节 */
const HEADER = 8;

export type LogStreamName = 'stdout' | 'stderr';

export interface LogFrame {
  stream: LogStreamName;
  /** 载荷原始字节。跨帧的多字节字符只有拼接后解码才不会坏，故此处不提前转字符串 */
  data: Buffer;
}

const STREAM_NAME: Record<number, LogStreamName> = { 0: 'stdout', 1: 'stdout', 2: 'stderr' };

/**
 * 判断是否为多路复用流。
 *
 * 逐帧走完整个缓冲：帧头必须是「流别 ≤ 2 且字节 1~3 全零」，且长度字段能把偏移
 * 一路推到缓冲末尾（`tail` 截断导致末帧不完整时会略微超出，同样算数）。
 * 普通文本第一个字节几乎不可能 ≤ 2，因此绝大多数情况一步即可判否。
 */
function isMultiplexed(buf: Buffer): boolean {
  let off = 0;
  let frames = 0;
  while (off + HEADER <= buf.length) {
    if (buf[off]! > 2) return false;
    if (buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) return false;
    off += HEADER + buf.readUInt32BE(off + 4);
    frames += 1;
  }
  return frames > 0;
}

/** 解帧。非多路复用（Tty:true）时整段按 stdout 返回。 */
export function demuxDockerLog(buf: Buffer): LogFrame[] {
  if (buf.length === 0) return [];
  if (!isMultiplexed(buf)) return [{ stream: 'stdout', data: buf }];

  const frames: LogFrame[] = [];
  let off = 0;
  while (off + HEADER <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    const start = off + HEADER;
    // 末帧可能被 tail 截断，按实有字节收下而不是丢弃
    frames.push({ stream: STREAM_NAME[buf[off]!] ?? 'stdout', data: buf.subarray(start, Math.min(start + len, buf.length)) });
    off = start + len;
  }
  return frames;
}

/**
 * 解帧并还原为文本。
 *
 * 先拼接载荷再统一解码 —— Docker 按写入分帧，一个多字节字符可能被切到两帧，
 * 逐帧解码会在切口留下替换字符。
 */
export function dockerLogToText(buf: Buffer): string {
  return Buffer.concat(demuxDockerLog(buf).map((f) => f.data)).toString('utf8');
}

/** 一行日志。行是 UI 的自然单位：级别过滤、导出、滚动都按行来 */
export interface LogLine {
  stream: LogStreamName;
  text: string;
}

/**
 * 增量解帧 + 按行切分，供 `follow` 流式输出使用。
 *
 * 比一次性解帧难在三处，都必须跨块保持状态：
 *   1. **8 字节帧头可能被切开** —— 攒够再解，不能读半个长度字段
 *   2. **载荷可能被切开** —— 尤其是多字节字符骑在块边界上，
 *      所以每条流各持一个流式 TextDecoder，而不是逐块 toString
 *   3. **一帧不等于一行** —— Docker 按「写入」分帧，一帧可能含多行，
 *      也可能只含半行，要跨帧拼
 *
 * 只吐完整行；末尾没有换行的残行留到 flush()。
 */
export class DockerLogStream {
  #buf: Buffer = Buffer.alloc(0);
  #mode: 'unknown' | 'framed' | 'raw' = 'unknown';
  #decoders: Record<LogStreamName, TextDecoder> = {
    stdout: new TextDecoder('utf-8'),
    stderr: new TextDecoder('utf-8'),
  };
  #pending: Record<LogStreamName, string> = { stdout: '', stderr: '' };

  push(chunk: Buffer): LogLine[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    if (this.#mode === 'unknown') this.#detect();
    if (this.#mode === 'raw') {
      const data = this.#buf;
      this.#buf = Buffer.alloc(0);
      return this.#absorb('stdout', data);
    }

    const lines: LogLine[] = [];
    let off = 0;
    while (this.#buf.length - off >= HEADER) {
      const len = this.#buf.readUInt32BE(off + 4);
      if (this.#buf.length - off - HEADER < len) break;      // 载荷还没到齐
      const stream = STREAM_NAME[this.#buf[off]!] ?? 'stdout';
      lines.push(...this.#absorb(stream, this.#buf.subarray(off + HEADER, off + HEADER + len)));
      off += HEADER + len;
    }
    this.#buf = off === 0 ? this.#buf : this.#buf.subarray(off);
    return lines;
  }

  /** 流结束时调用：吐出最后一段没有换行结尾的内容 */
  flush(): LogLine[] {
    const out: LogLine[] = [];
    for (const s of ['stdout', 'stderr'] as const) {
      const tail = this.#pending[s] + this.#decoders[s].decode();
      this.#pending[s] = '';
      if (tail !== '') out.push({ stream: s, text: tail });
    }
    return out;
  }

  /**
   * 模式探测。首字节 > 2 即可判定为无帧头的原始流（Tty:true）——
   * 日志正文几乎不可能以 \x00~\x02 开头。否则要等够 8 字节才敢下结论。
   */
  #detect(): void {
    if (this.#buf.length === 0) return;
    if (this.#buf[0]! > 2) { this.#mode = 'raw'; return; }
    if (this.#buf.length < HEADER) return;                   // 再等等
    this.#mode =
      this.#buf[1] === 0 && this.#buf[2] === 0 && this.#buf[3] === 0 ? 'framed' : 'raw';
  }

  /** 解码一段载荷，拼进对应流的残行缓冲，切出完整行 */
  #absorb(stream: LogStreamName, data: Buffer): LogLine[] {
    const text = this.#pending[stream] + this.#decoders[stream].decode(data, { stream: true });
    const parts = text.split('\n');
    this.#pending[stream] = parts.pop() ?? '';               // 最后一段可能是半行
    return parts.map((t) => ({ stream, text: t }));
  }
}

/**
 * 拆出 Docker `timestamps` 前缀。
 *
 * 形如 `2026-08-26T15:10:38.123456789Z <正文>`。Go 的 RFC3339Nano 会**裁掉小数末尾的零**，
 * 所以宽度不固定；这里把小数补齐到 9 位，让时间戳可以直接按字符串比较 ——
 * 断线续传要靠它判断「这一行是不是已经发过了」。
 */
export function splitTimestamp(line: string): { ts: string; text: string } {
  const sp = line.indexOf(' ');
  if (sp < 0) return { ts: '', text: line };
  const head = line.slice(0, sp);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(head);
  if (!m) return { ts: '', text: line };
  return { ts: `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z`, text: line.slice(sp + 1) };
}
