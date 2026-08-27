import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarFile } from './tar.ts';

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
