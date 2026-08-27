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

test('过长文件名被拒绝而不是静默截断', () => {
  assert.throws(() => tarFile('a'.repeat(120), 'x'), /过长/);
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
