import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SegmentLog, SegmentLogError } from './segment-log.ts';

const dir = () => mkdtemp(join(tmpdir(), 'tle-seg-'));
const buf = (s: string) => Buffer.from(s, 'utf8');
const collect = async (log: SegmentLog, from?: { segment: number; offset: number }) => {
  const out: string[] = [];
  for await (const r of log.read(from)) out.push(r.payload.toString('utf8'));
  return out;
};

test('顺序写入后能按序读回', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d });
  for (const s of ['a', 'b', 'c']) await log.append(buf(s));
  assert.deepEqual(await collect(log), ['a', 'b', 'c']);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('超过段上限自动滚动新段', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d, maxSegmentBytes: 32 });
  for (let i = 0; i < 6; i++) await log.append(buf(`record-${i}`));  // 每条 8+9=17 字节
  assert.ok(log.segments.length >= 3, `应滚出多段，实际 ${log.segments.length}`);
  assert.deepEqual(await collect(log), [0, 1, 2, 3, 4, 5].map((i) => `record-${i}`),
                   '跨段读取顺序必须完整');
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('单条超过段上限时也能写进去，不会卡死', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d, maxSegmentBytes: 16 });
  const big = buf('x'.repeat(100));
  await log.append(big);
  assert.deepEqual((await collect(log))[0], 'x'.repeat(100));
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('崩溃恢复：尾部写了一半的记录被截掉', async () => {
  const d = await dir();
  let log = await SegmentLog.open({ dir: d });
  await log.append(buf('good-1'));
  await log.append(buf('good-2'));
  await log.close();

  // 模拟掉电：追加一段残缺的记录头（声称有 999 字节载荷，实际什么都没写）
  const segFile = join(d, (await readdir(d)).find((f) => f.endsWith('.seg'))!);
  const fh = await open(segFile, 'a');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(999, 0);
  head.writeUInt32BE(0x1234, 4);
  await fh.write(head);
  await fh.close();
  const sizeBefore = (await stat(segFile)).size;

  log = await SegmentLog.open({ dir: d });
  assert.deepEqual(await collect(log), ['good-1', 'good-2'], '完整记录必须还在');
  const sizeAfter = (await stat(segFile)).size;
  assert.ok(sizeAfter < sizeBefore, '残缺尾部应被截断');

  // 截断之后还能继续写
  await log.append(buf('after-recovery'));
  assert.deepEqual(await collect(log), ['good-1', 'good-2', 'after-recovery']);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('崩溃恢复：载荷被写坏（CRC 不符）同样截断', async () => {
  const d = await dir();
  let log = await SegmentLog.open({ dir: d });
  await log.append(buf('keep-me'));
  await log.append(buf('corrupt-me'));
  await log.close();

  const segFile = join(d, (await readdir(d)).find((f) => f.endsWith('.seg'))!);
  const fh = await open(segFile, 'r+');
  // 'keep-me' 占 8+7=15 字节，第二条载荷从 15+8=23 开始，改一个字节
  await fh.write(Buffer.from('X'), 0, 1, 23);
  await fh.close();

  log = await SegmentLog.open({ dir: d });
  assert.deepEqual(await collect(log), ['keep-me'], '坏记录及其之后都不该读出来');
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('读到坏记录停在那里，不跳过继续读', async () => {
  // 分段日志是顺序结构，跳过一条坏记录之后的偏移全是猜的
  const d = await dir();
  const log = await SegmentLog.open({ dir: d });
  await log.append(buf('one'));
  await log.append(buf('two'));
  await log.append(buf('three'));
  await log.flush();
  const segFile = join(d, (await readdir(d)).find((f) => f.endsWith('.seg'))!);
  const fh = await open(segFile, 'r+');
  await fh.write(Buffer.from('Z'), 0, 1, 8 + 3 + 8);   // 打坏第二条的载荷
  await fh.close();
  assert.deepEqual(await collect(log), ['one']);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('可从指定偏移续读 —— 补传进度靠它', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d });
  await log.append(buf('a'));
  const second = await log.append(buf('b'));
  await log.append(buf('c'));
  assert.deepEqual(await collect(log, second), ['b', 'c']);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('整段回收后不再读到，当前写入段不允许删', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d, maxSegmentBytes: 24 });
  await log.append(buf('seg1-a'));
  await log.append(buf('seg2-a'));
  const oldest = log.segments[0]!;
  await log.removeSegment(oldest);
  assert.ok(!log.segments.includes(oldest));
  assert.deepEqual(await collect(log), ['seg2-a']);
  await assert.rejects(() => log.removeSegment(log.currentSegment), SegmentLogError);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('重开后接着原来的段写，不覆盖旧数据', async () => {
  const d = await dir();
  let log = await SegmentLog.open({ dir: d });
  await log.append(buf('before'));
  await log.close();
  log = await SegmentLog.open({ dir: d });
  await log.append(buf('after'));
  assert.deepEqual(await collect(log), ['before', 'after']);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('空目录开出来可用，且没有幽灵记录', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d });
  assert.deepEqual(await collect(log), []);
  assert.equal(await log.totalBytes(), 0);
  await log.close();
  await rm(d, { recursive: true, force: true });
});

test('二进制载荷原样往返（不是只支持文本）', async () => {
  const d = await dir();
  const log = await SegmentLog.open({ dir: d });
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 0, 10, 13]);
  await log.append(bin);
  const out: Buffer[] = [];
  for await (const r of log.read()) out.push(r.payload);
  assert.deepEqual(out[0], bin);
  await log.close();
  await rm(d, { recursive: true, force: true });
});
