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

const BLOCK = 512;
const USTAR_NAME_BYTES = 100;
const USTAR_PREFIX_BYTES = 155;
const USTAR_PATH_BYTES = 255;

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
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > len) throw new Error(`${label} 超过 USTAR 字段上限 ${len} 字节`);
  bytes.copy(buf, offset);
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  const total = Buffer.byteLength(path);
  if (total > USTAR_PATH_BYTES) {
    throw new Error(`文件名过长（USTAR 上限 ${USTAR_PATH_BYTES} 字节）：${path}`);
  }
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
  throw new Error(`文件名过长（无法按 USTAR name/prefix 安全分割）：${path}`);
}

function readTextField(header: Buffer, offset: number, len: number): string {
  const bytes = header.subarray(offset, offset + len);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
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

/** 单个文件的头 + 数据 + 补齐，不含结尾空块 */
function tarMember(name: string, content: string | Buffer, opts: TarOwner = {}): Buffer {
  const { mode = 0o644, uid = 0, gid = 0 } = opts;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const path = splitUstarPath(name);

  const header = Buffer.alloc(BLOCK, 0);
  writeTextField(header, 0, USTAR_NAME_BYTES, path.name, 'USTAR name');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, uid);
  writeOctal(header, 116, 8, gid);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.write('0', 156); // typeflag: 普通文件
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

/**
 * 解包。
 *
 * 只认普通文件（typeflag `0` / `\0`），其余类型（目录、链接、pax 头）跳过 ——
 * 我们自己产出的归档不含它们；外来归档里出现时，跳过比猜着解更安全。
 * 校验和不符直接抛错：备份文件损坏必须当场知道，而不是恢复出半个系统。
 */
export function untar(archive: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= archive.length) {
    const header = archive.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;            // 结尾空块

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
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    const start = off + BLOCK;
    if (typeflag === '0' || typeflag === '\0' || header[156] === 0) {
      out.push({ name, content: archive.subarray(start, start + size) });
    }
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
