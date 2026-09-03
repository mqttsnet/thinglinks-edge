/**
 * 最小 tar 打包与解包。
 *
 * 起初只为把 settings.js 写进容器数据卷；备份恢复（T4.3）需要多文件归档与解包，
 * 因此在同一格式子集上扩了 `tarArchive` / `untar`。
 *
 * 不引第三方 tar 库：本项目已被三个停更包坑过（两个 Mongo 包、http-proxy），
 * 而这里只需要 tar 的一个最简子集（普通文件、USTAR prefix 长名、无稀疏），
 * 自己实现 40 行并有测试覆盖，比引入一个可能停更的依赖更可控。
 */

import { createHash } from 'node:crypto';

const BLOCK = 512;
const USTAR_NAME_BYTES = 100;
const USTAR_PREFIX_BYTES = 155;
const USTAR_PATH_BYTES = 255;
const PAX_PATH_BYTES = 4096;
const PAX_HEADER_BYTES = 8192;
const PAX_KEY_BYTES = 128;

function assertWellFormedUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} 含孤立 UTF-16 高代理项`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} 含孤立 UTF-16 低代理项`);
    }
  }
}

function writeField(buf: Buffer, offset: number, len: number, value: string): void {
  buf.write(value.slice(0, len - 1), offset, 'utf8');
}

/** USTAR 文本字段允许占满全部字节；短值由已清零的 header 自动 NUL 终止。 */
function writeTextField(
  buf: Buffer,
  offset: number,
  len: number,
  value: string,
  label: string,
): void {
  assertWellFormedUtf16(value, label);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > len) throw new Error(`${label} 超过 USTAR 字段上限 ${len} 字节`);
  bytes.copy(buf, offset);
}

function splitUstarPath(path: string): { name: string; prefix: string } | undefined {
  const total = Buffer.byteLength(path);
  if (total > USTAR_PATH_BYTES) return undefined;
  if (total <= USTAR_NAME_BYTES) return { name: path, prefix: '' };

  let slash = path.lastIndexOf('/');
  while (slash >= 0) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (
      prefix.length > 0
      && name.length > 0
      && Buffer.byteLength(prefix) <= USTAR_PREFIX_BYTES
      && Buffer.byteLength(name) <= USTAR_NAME_BYTES
    ) return { name, prefix };
    slash = path.lastIndexOf('/', slash - 1);
  }
  return undefined;
}

function readTextField(header: Buffer, offset: number, len: number): string {
  const bytes = header.subarray(offset, offset + len);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
}

function paxRecord(key: string, value: string): Buffer {
  assertWellFormedUtf16(key, 'PAX key');
  assertWellFormedUtf16(value, 'PAX value');
  const keyBytes = Buffer.from(key, 'utf8');
  const valueBytes = Buffer.from(value, 'utf8');
  if (
    keyBytes.length === 0
    || keyBytes.length > PAX_KEY_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)
    || keyBytes.includes(0)
    || valueBytes.includes(0)
  ) throw new Error('PAX key/value 非法');
  const suffix = Buffer.from(` ${key}=${value}\n`, 'utf8');
  let length = suffix.length + 1;
  while (true) {
    const record = Buffer.concat([Buffer.from(String(length), 'ascii'), suffix]);
    if (record.length === length) {
      if (record.length > PAX_HEADER_BYTES) throw new Error('PAX record 过长');
      return record;
    }
    length = record.length;
  }
}

function paxPathRecord(path: string): Buffer {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length === 0 || bytes.length > PAX_PATH_BYTES || bytes.includes(0)) {
    throw new Error(`文件名过长或非法（PAX 路径上限 ${PAX_PATH_BYTES} 字节）：${path}`);
  }
  return paxRecord('path', path);
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  // tar 数值字段为八进制字符串，右对齐补零，末位留 NUL
  writeField(buf, offset, len, value.toString(8).padStart(len - 1, '0'));
}

export interface TarOwner {
  mode?: number;
  /** 属主必须能指定：容器内以 node-red(1000) 读取，属主不对就打不开 */
  uid?: number;
  gid?: number;
}

export interface TarEntry extends TarOwner {
  name: string;
  content: string | Buffer;
}

/** 一个 USTAR 头 + 数据 + 补齐，不含结尾空块。 */
function ustarMember(
  path: { name: string; prefix: string },
  data: Buffer,
  opts: TarOwner,
  typeflag: '0' | 'x',
): Buffer {
  const { mode = 0o644, uid = 0, gid = 0 } = opts;

  const header = Buffer.alloc(BLOCK, 0);
  writeTextField(header, 0, USTAR_NAME_BYTES, path.name, 'USTAR name');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, uid);
  writeOctal(header, 116, 8, gid);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.write(typeflag, 156);
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  writeTextField(header, 345, USTAR_PREFIX_BYTES, path.prefix, 'USTAR prefix');

  // 校验和：先以 8 个空格填充该字段，求和后按 tar 规范写回
  // 字段布局为 6 位八进制 + NUL + 空格，写满 7 位会破坏格式
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0'), 148, 'utf8');
  header[154] = 0x00;
  header[155] = 0x20;

  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([header, data, padding]);
}

/** 单个逻辑文件；超出 USTAR 时先写本地 PAX path，再写安全占位普通头。 */
function tarMember(name: string, content: string | Buffer, opts: TarOwner = {}): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  assertWellFormedUtf16(name, '文件名');
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length === 0 || nameBytes.length > PAX_PATH_BYTES || nameBytes.includes(0)) {
    throw new Error(`文件名过长或非法（PAX 路径上限 ${PAX_PATH_BYTES} 字节）：${name}`);
  }
  const ustar = splitUstarPath(name);
  if (ustar) return ustarMember(ustar, data, opts, '0');

  const pathRecord = paxPathRecord(name);
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 32);
  const paxName = splitUstarPath(`PaxHeaders/${digest}`);
  const placeholder = splitUstarPath(`PaxFiles/${digest}`);
  if (!paxName || !placeholder) throw new Error('PAX 占位路径构造失败');
  return Buffer.concat([
    ustarMember(paxName, pathRecord, { ...opts, mode: 0o600 }, 'x'),
    ustarMember(placeholder, data, opts, '0'),
  ]);
}

/** tar 以两个空块结尾 */
const TRAILER = () => Buffer.alloc(BLOCK * 2, 0);

/** 打包单个普通文件为 tar 字节流 */
export function tarFile(name: string, content: string | Buffer, opts: TarOwner = {}): Buffer {
  return Buffer.concat([tarMember(name, content, opts), TRAILER()]);
}

/** 打包多个文件。条目顺序即归档顺序，解包时按同序还原 */
export function tarArchive(entries: TarEntry[]): Buffer {
  return Buffer.concat([
    ...entries.map((e) => tarMember(e.name, e.content, e)),
    TRAILER(),
  ]);
}

// `ignoreBOM: true` means U+FEFF is ordinary path/key content and is not stripped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodePaxText(bytes: Buffer, label: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`PAX ${label} 不是合法 UTF-8`);
  }
}

function parsePaxHeader(content: Buffer): { path?: string } {
  if (content.length === 0 || content.length > PAX_HEADER_BYTES) {
    throw new Error(`PAX header 大小非法或超过 ${PAX_HEADER_BYTES} 字节`);
  }
  let offset = 0;
  let path: string | undefined;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) throw new Error('PAX record 缺少长度分隔符');
    const lengthBytes = content.subarray(offset, space);
    if (
      lengthBytes.length === 0
      || lengthBytes[0] === 0x30
      || [...lengthBytes].some((byte) => byte < 0x30 || byte > 0x39)
    ) throw new Error('PAX record 长度不是正十进制');
    const lengthText = lengthBytes.toString('ascii');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length > PAX_HEADER_BYTES) {
      throw new Error('PAX record 长度超限');
    }
    const end = offset + length;
    if (end > content.length || end <= space + 2) throw new Error('PAX record 被截断');
    const record = content.subarray(offset, end);
    if (record[record.length - 1] !== 0x0a) throw new Error('PAX record 未以换行结束');
    const payload = content.subarray(space + 1, end - 1);
    const equals = payload.indexOf(0x3d);
    if (equals <= 0) throw new Error('PAX record 缺少 key=value');
    const keyBytes = payload.subarray(0, equals);
    const valueBytes = payload.subarray(equals + 1);
    if (keyBytes.includes(0) || valueBytes.includes(0)) throw new Error('PAX record 含 NUL');
    const key = decodePaxText(keyBytes, 'key');
    if (
      keyBytes.length > PAX_KEY_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)
    ) throw new Error('PAX record key 非法');
    if (key === 'path') {
      if (path !== undefined) throw new Error('PAX path 重复');
      if (valueBytes.length === 0 || valueBytes.length > PAX_PATH_BYTES) {
        throw new Error('PAX path 大小非法');
      }
      path = decodePaxText(valueBytes, 'path');
    }
    // 未使用的安全 key 仍经过长度/NUL/UTF-8 校验，再有界忽略。
    else decodePaxText(valueBytes, `value ${key}`);
    offset = end;
  }
  return path === undefined ? {} : { path };
}

/**
 * 解包。
 *
 * 只认普通文件（typeflag `0` / `\0`）和紧邻其后的本地 PAX `x` path。
 * 目录、链接及其它类型仍跳过；PAX 严格绑定下一普通文件且只生效一次。
 * 校验和不符直接抛错：备份文件损坏必须当场知道，而不是恢复出半个系统。
 */
export function untar(archive: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let pendingPax: { path?: string } | undefined;
  while (off + BLOCK <= archive.length) {
    const header = archive.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) {
      if (pendingPax) throw new Error('PAX header 后缺少普通文件');
      break;
    }

    const stored = header.subarray(148, 156);
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of check) sum += b;
    const expected = parseInt(stored.toString('utf8').replace(/\0.*$/, '').trim() || '-1', 8);
    if (sum !== expected) {
      throw new Error(`tar 校验和不符（偏移 ${off}），归档已损坏`);
    }

    const leaf = readTextField(header, 0, USTAR_NAME_BYTES);
    const magic = readTextField(header, 257, 6);
    const prefix = magic === 'ustar' ? readTextField(header, 345, USTAR_PREFIX_BYTES) : '';
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    const size = parseInt(
      header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('tar 条目大小非法');
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    const start = off + BLOCK;
    if (start + size > archive.length) throw new Error('tar 条目内容被截断');
    const regular = typeflag === '0' || typeflag === '\0' || header[156] === 0;
    if (typeflag === 'x') {
      if (pendingPax) throw new Error('PAX header 未绑定文件前重复出现');
      pendingPax = parsePaxHeader(archive.subarray(start, start + size));
    } else if (regular) {
      out.push({
        name: pendingPax?.path ?? name,
        content: archive.subarray(start, start + size),
      });
      pendingPax = undefined;
    } else if (pendingPax) {
      throw new Error('PAX header 后的条目不是普通文件');
    }
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (pendingPax) throw new Error('PAX header 后缺少普通文件');
  return out;
}
