import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarFile, tarArchive, untar } from './tar.ts';

/** 用系统 tar 解包验证 —— 自己写的格式必须能被标准工具读出来 */
function roundTrip(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tle-tar-'));
  const archive = join(dir, 'a.tar');
  writeFileSync(archive, tarFile(name, content));
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  return readFileSync(join(dir, name), 'utf8');
}

test('系统 tar 能正确解出内容', () => {
  assert.equal(roundTrip('settings.js', 'module.exports = { a: 1 };\n'), 'module.exports = { a: 1 };\n');
});

test('非 512 整数倍的内容正确填充', () => {
  for (const len of [1, 511, 512, 513, 2048]) {
    const body = 'x'.repeat(len);
    assert.equal(roundTrip('f.txt', body), body, `长度 ${len} 应正确还原`);
  }
});

test('UTF-8 内容不被破坏', () => {
  const body = '// 由 ThingLinks Edge 生成\nmodule.exports = { 名称: "一号产线" };\n';
  assert.equal(roundTrip('settings.js', body), body);
});

test('归档整体为 512 的整数倍', () => {
  assert.equal(tarFile('a.txt', 'hi').length % 512, 0);
});

test('含 NUL 的文件名被拒绝而不是静默截断', () => {
  assert.throws(() => tarFile('safe\0hidden', 'x'), /非法/);
});

const npmCachePath = [
  'instances', 'a'.repeat(32), '.npm', '_cacache', 'content-v2', 'sha512',
  '34', 'ab', 'c'.repeat(124),
].join('/');

test('真实 npm cacache 2/2/124 长路径使用 PAX 且系统 tar 与自身都能还原', () => {
  assert.ok(Buffer.byteLength(npmCachePath) > 100);
  assert.ok(Buffer.byteLength(npmCachePath) <= 255);
  const content = 'cached-package-bytes';
  assert.equal(roundTrip(npmCachePath, content), content);
  const own = untar(tarFile(npmCachePath, content));
  assert.equal(own[0]?.name, npmCachePath);
  assert.equal(own[0]?.content.toString(), content);
});

test('ustar name 字段支持 99、100，无法分割的 101 字节自动走 PAX', () => {
  for (const length of [99, 100]) {
    const name = 'n'.repeat(length);
    assert.equal(roundTrip(name, `n${length}`), `n${length}`);
    assert.equal(untar(tarFile(name, 'x'))[0]?.name, name);
  }
  const pax101 = 'n'.repeat(101);
  assert.equal(roundTrip(pax101, 'pax-101'), 'pax-101');
  assert.equal(untar(tarFile(pax101, 'x'))[0]?.name, pax101);
  assert.equal(String.fromCharCode(tarFile(pax101, 'x')[156]!), 'x');
});

test('ustar prefix/name 精确支持 255 字节，256 字节自动走 PAX', () => {
  const exact255 = `${'p'.repeat(154)}/${'n'.repeat(100)}`;
  assert.equal(Buffer.byteLength(exact255), 255);
  assert.equal(roundTrip(exact255, 'max'), 'max');
  assert.equal(untar(tarFile(exact255, 'max'))[0]?.name, exact255);

  const exactPrefix155 = `${'p'.repeat(155)}/${'n'.repeat(99)}`;
  assert.equal(Buffer.byteLength(exactPrefix155), 255);
  assert.equal(roundTrip(exactPrefix155, 'prefix-max'), 'prefix-max');
  assert.equal(untar(tarFile(exactPrefix155, 'prefix-max'))[0]?.name, exactPrefix155);

  const over256 = `${'p'.repeat(155)}/${'n'.repeat(100)}`;
  assert.equal(Buffer.byteLength(over256), 256);
  assert.equal(roundTrip(over256, 'pax-256'), 'pax-256');
  assert.equal(untar(tarFile(over256, 'x'))[0]?.name, over256);
});

test('ustar 无安全分割点时改用 PAX，不截断 prefix 或最终分量', () => {
  const prefixTooLong = `${'p'.repeat(156)}/${'n'.repeat(98)}`;
  const finalComponentTooLong = `prefix/${'n'.repeat(101)}`;
  assert.equal(Buffer.byteLength(prefixTooLong), 255);
  assert.equal(untar(tarFile(prefixTooLong, 'x'))[0]?.name, prefixTooLong);
  assert.equal(untar(tarFile(finalComponentTooLong, 'x'))[0]?.name, finalComponentTooLong);
});

test('ustar 多字节路径按字节分割，不截断 UTF-8 字符', () => {
  const prefix = '目录'.repeat(25); // 150 bytes
  const suffix = `${'文件'.repeat(16)}.js`; // 99 bytes
  const name = `${prefix}/${suffix}`;
  assert.equal(Buffer.byteLength(name), 250);
  assert.equal(roundTrip(name, '中文路径'), '中文路径');
  assert.equal(untar(tarFile(name, '中文路径'))[0]?.name, name);
});

test('PAX 多字节最终分量按 UTF-8 字节完整往返', () => {
  const name = `prefix/${'文件'.repeat(40)}`; // final component 240 bytes
  assert.ok(Buffer.byteLength(name.slice(name.indexOf('/') + 1)) > 100);
  assert.equal(roundTrip(name, 'pax 中文'), 'pax 中文');
  assert.equal(untar(tarFile(name, 'pax 中文'))[0]?.name, name);
});

test('PAX 路径上限 4096 字节，超过一字节即拒绝', () => {
  const max = 'm'.repeat(4096);
  assert.equal(untar(tarFile(max, 'max'))[0]?.name, max);
  assert.throws(() => tarFile('m'.repeat(4097), 'x'), /过长/);
});

test('可指定属主 —— 容器内以 node-red(1000) 身份读取', () => {
  const buf = tarFile('settings.js', 'x', { uid: 1000, gid: 1000 });
  // uid 字段在 108 偏移，八进制字符串
  assert.equal(buf.subarray(108, 115).toString('utf8').replace(/\0+$/, ''), '0001750');
});

// ── 多文件归档与解包（备份恢复用）────────────────────────────

test('多文件归档能被系统 tar 正确解出', () => {
  // 自研格式必须能被标准工具读出来 —— 备份文件是要给运维用的
  const dir = mkdtempSync(join(tmpdir(), 'tle-tar-multi-'));
  const archive = join(dir, 'a.tar');
  writeFileSync(archive, tarArchive([
    { name: 'manifest.json', content: '{"v":1}' },
    { name: 'manager/edge.db', content: Buffer.from([1, 2, 3, 0, 255]) },
    { name: 'instances/line-a/flows.json', content: '[]' },
  ]));
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), '{"v":1}');
  assert.deepEqual(readFileSync(join(dir, 'manager/edge.db')), Buffer.from([1, 2, 3, 0, 255]));
  assert.equal(readFileSync(join(dir, 'instances/line-a/flows.json'), 'utf8'), '[]');
});

test('自己写的能自己解回来，二进制不失真', () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
  const back = untar(tarArchive([
    { name: 'a.txt', content: '文本内容' },
    { name: 'b.bin', content: bin },
  ]));
  assert.deepEqual(back.map((e) => e.name), ['a.txt', 'b.bin']);
  assert.equal((back[0]!.content as Buffer).toString('utf8'), '文本内容');
  assert.deepEqual(back[1]!.content, bin);
});

test('能解开系统 tar 产出的归档', () => {
  // 只能解自己写的不算数：恢复时拿到的可能是运维用 tar 重新打的包
  const dir = mkdtempSync(join(tmpdir(), 'tle-tar-sys-'));
  writeFileSync(join(dir, 'x.txt'), 'from-system-tar');
  writeFileSync(join(dir, 'y.txt'), '第二个文件');
  const archive = join(dir, 'sys.tar');
  execFileSync('tar', ['-cf', archive, '-C', dir, 'x.txt', 'y.txt']);
  const back = untar(readFileSync(archive));
  const byName = Object.fromEntries(back.map((e) => [e.name, (e.content as Buffer).toString('utf8')]));
  assert.equal(byName['x.txt'], 'from-system-tar');
  assert.equal(byName['y.txt'], '第二个文件');
});

test('归档损坏时当场报错，不恢复出半个系统', () => {
  const good = tarArchive([{ name: 'a', content: 'hello world padding to block' }]);
  const bad = Buffer.from(good);
  bad[10] = bad[10]! ^ 0xff;          // 打坏文件名区
  assert.throws(() => untar(bad), /校验和不符/);
});

test('空归档解出空数组', () => {
  assert.deepEqual(untar(tarArchive([])), []);
});

// ── 真实 npm 包体（对着 nodered/node-red 生态实测后补的回归）──────────
//
// 私有节点源要读的是 `npm pack` 产出的 tgz，而那是**别人**的 tar 写出来的。
// 已拿 node-red-contrib-modbus 及其 71 个闭包依赖（1722 个条目）逐个验过，
// 全部走普通文件头。下面两条钉住的是那批里没出现、但 npm 确实会产出的形状 ——
// 缺了它们，换一个路径更深的包就会踩到。

/** 造一个 512 字节的 tar 头，校验和按规范算好 */
function header(name: string, size: number, typeflag: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'utf8');
  h.write('0000000\0', 108, 'utf8');
  h.write('0000000\0', 116, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  h.write('00000000000\0', 136, 'utf8');
  h.write(typeflag, 156, 'utf8');
  h.write('ustar\0', 257, 'utf8');
  h.write('00', 263, 'utf8');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0'), 148, 'utf8');
  h[154] = 0x00;
  h[155] = 0x20;
  return h;
}

function member(name: string, body: string, typeflag = '0'): Buffer {
  const data = Buffer.from(body, 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header(name, data.length, typeflag), data, pad]);
}

function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (true) {
    const record = `${length}${suffix}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

test('外部 npm PAX path 精确应用到下一普通文件，未知安全 key 被忽略且随后条目不错位', () => {
  /*
   * 路径超过 100 字节时 npm（node-tar）会先写一个 typeflag `x` 的 PaxHeader 条目，
   * 里面是真实路径，紧跟着才是被截断名字的数据条目。实测 `npm pack` 一个
   * 288 字节路径的包，产出的正是这个形状。
   *
   * 备份恢复现在也会产出 PAX，所以必须严格解析本地 path；其它安全 key
   * 有界忽略，同时仍按 size 对齐，不能影响紧随其后的普通条目。
   */
  const longName = `package/${'x'.repeat(200)}.txt`;
  const pax = paxRecord('comment', 'npm-generated') + paxRecord('path', longName);
  const archive = Buffer.concat([
    member('package/package.json', '{"name":"a","version":"1.0.0"}'),
    member('PaxHeader/long.txt', pax, 'x'),
    member('xxxx/truncated-name.txt', 'deep'),
    member('package/after.txt', 'after'),
    Buffer.alloc(1024, 0),
  ]);
  const files = untar(archive);
  assert.deepEqual(files.map((f) => f.name),
    ['package/package.json', longName, 'package/after.txt']);
  assert.equal(files[0]!.content.toString(), '{"name":"a","version":"1.0.0"}');
  assert.equal(files[1]!.content.toString(), 'deep');
  assert.equal(files[2]!.content.toString(), 'after');
});

test('PAX record 对非十进制、零长度、截断、重复 path、NUL 与超限严格拒绝', () => {
  const archiveFor = (pax: string) => Buffer.concat([
    member('PaxHeader/invalid', pax, 'x'),
    member('placeholder', 'x'),
    Buffer.alloc(1024, 0),
  ]);
  for (const pax of [
    'x path=a\n',
    '0 path=a\n',
    '30 path=short\n',
    paxRecord('path', 'first') + paxRecord('path', 'second'),
    paxRecord('path', 'bad\0name'),
    '9000 path=a\n',
  ]) assert.throws(() => untar(archiveFor(pax)), /PAX/);
});

test('PAX header 必须恰好绑定下一普通文件，悬空或插入其它类型均拒绝', () => {
  const pax = paxRecord('path', `deep/${'x'.repeat(120)}`);
  assert.throws(() => untar(Buffer.concat([
    member('PaxHeader/dangling', pax, 'x'), Buffer.alloc(1024, 0),
  ])), /PAX/);
  assert.throws(() => untar(Buffer.concat([
    member('PaxHeader/not-regular', pax, 'x'),
    member('directory/', '', '5'),
    member('placeholder', 'x'),
    Buffer.alloc(1024, 0),
  ])), /PAX/);
});

test('目录条目被跳过，不会混进文件列表', () => {
  // npm 打包时常带目录条目（typeflag `5`，size 为 0）
  const archive = Buffer.concat([
    member('package/', '', '5'),
    member('package/package.json', '{"name":"a","version":"1.0.0"}'),
    Buffer.alloc(1024, 0),
  ]);
  assert.deepEqual(untar(archive).map((f) => f.name), ['package/package.json']);
});
