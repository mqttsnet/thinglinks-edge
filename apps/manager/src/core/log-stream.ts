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
