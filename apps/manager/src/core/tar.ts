/**
 * 最小 tar 打包 —— 只为把 settings.js 写进容器数据卷。
 *
 * 不引第三方 tar 库：本项目已被三个停更包坑过（两个 Mongo 包、http-proxy），
 * 而这里只需要 tar 的一个最简子集（普通文件、无长名、无稀疏），
 * 自己实现 40 行并有测试覆盖，比引入一个可能停更的依赖更可控。
 */

const BLOCK = 512;

function writeField(buf: Buffer, offset: number, len: number, value: string): void {
  buf.write(value.slice(0, len - 1), offset, 'utf8');
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  // tar 数值字段为八进制字符串，右对齐补零，末位留 NUL
  writeField(buf, offset, len, value.toString(8).padStart(len - 1, '0'));
}

/** 打包单个普通文件为 tar 字节流 */
export function tarFile(
  name: string,
  content: string | Buffer,
  opts: { mode?: number; uid?: number; gid?: number } = {},
): Buffer {
  const { mode = 0o644, uid = 0, gid = 0 } = opts;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (Buffer.byteLength(name) > 99) {
    throw new Error(`文件名过长（tar 普通头上限 99 字节）：${name}`);
  }

  const header = Buffer.alloc(BLOCK, 0);
  writeField(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, uid);
  writeOctal(header, 116, 8, gid);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.write('0', 156); // typeflag: 普通文件
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');

  // 校验和：先以 8 个空格填充该字段，求和后按 tar 规范写回
  // 字段布局为 6 位八进制 + NUL + 空格，写满 7 位会破坏格式
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0'), 148, 'utf8');
  header[154] = 0x00;
  header[155] = 0x20;

  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  const trailer = Buffer.alloc(BLOCK * 2, 0); // tar 以两个空块结尾
  return Buffer.concat([header, data, padding, trailer]);
}
