/**
 * 落盘失败的告警测试。
 *
 * 修的是一个不对称：「逻辑写满」（超过 maxBytes）一直有告警与审计，
 * 而「物理写不进去」（ENOSPC、磁盘故障、权限）**悄无声息** —— 后者明明更严重。
 * 场景实测过：云端断 + 磁盘写不进去时，上报接口照回 202 queued，
 * 审计表是空的，只有一个内存计数器。
 *
 * **这些用例必须是确定性的。** 第一版靠「删目录 + 等定时器」来制造失败，
 * 结果两次跑挂在不同用例上 —— 不稳定的测试比没有测试更糟，它会训练人忽略红灯。
 * 原因是删目录**挡不住已打开的 fd**（POSIX 语义，inode 活到 fd 关闭），
 * 到底哪一次 append 会失败取决于换段时机，是个竞态。
 *
 * 现在两条失败路径各用一个确定性手段：
 *   · append 失败 —— 把目录换成同名文件，再用 maxSegmentBytes=1 逼每次都换段，
 *     换段要新建文件，必然 ENOTDIR
 *   · flush 失败  —— 注入 fsyncFn（测试专用口子，与 MicroBatcher 的 setTimer 同类）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from './spool.ts';

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'tle-werr-')), 'spool');

/** 把 spool 目录换成同名普通文件：之后任何新建段文件都必然 ENOTDIR */
async function breakDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await writeFile(dir, '');
}

test('正常写入不产生任何落盘告警', async () => {
  const alarms: unknown[] = [];
  const spool = await Spool.open({
    dir: freshDir(), flushIntervalMs: 10, fullPolicy: 'drop-oldest',
    onWriteError: (i) => alarms.push(i),
  });
  for (let i = 0; i < 20; i++) await spool.enqueue({ i });
  assert.deepEqual(alarms, []);
  assert.equal((await spool.metrics()).lastFlushError, '', '落盘正常时该字段是空串');
  await spool.close();
});

test('写不进去时：告警带原因，并且照样抛错给上层', async () => {
  const dir = freshDir();
  const alarms: Array<{ phase: string; error: string }> = [];
  const spool = await Spool.open({
    dir, flushIntervalMs: 10_000, fullPolicy: 'drop-oldest',
    maxSegmentBytes: 1,                       // 首条之后每次 append 都换段
    onWriteError: (i) => alarms.push(i),
  });
  await spool.enqueue({ first: true });       // 这条建了首段，能成功
  await breakDir(dir);

  await assert.rejects(() => spool.enqueue({ second: true }),
    '写不进去必须抛错，不能吞掉当成功');

  assert.equal(alarms.length, 1, '一次失败一条告警');
  assert.equal(alarms[0]!.phase, 'append');
  assert.ok(alarms[0]!.error.length > 0, '告警要带原因，否则现场无从下手');
});

/*
 * fsync 失败尤其危险：数据在页缓存里但没落盘，掉电就没了，
 * 而 spool 照常报告「已存」。早先这里是 `.catch(() => undefined)` 无条件吞掉。
 */
test('刷盘失败会告警，并留在指标里供诊断包看见', async () => {
  const alarms: Array<{ phase: string; error: string }> = [];
  let brokenDisk = false;
  const spool = await Spool.open({
    dir: freshDir(), flushIntervalMs: 10, fullPolicy: 'drop-oldest',
    onWriteError: (i) => alarms.push(i),
    fsyncFn: async () => { if (brokenDisk) throw new Error('EIO: i/o error'); },
  });

  await spool.enqueue({ a: 1 });
  brokenDisk = true;
  await spool.enqueue({ b: 2 });
  // 等定时刷盘转一轮
  for (let i = 0; i < 40 && alarms.length === 0; i++) await new Promise((r) => setTimeout(r, 15));

  assert.equal(alarms.length >= 1, true, '刷盘失败必须告警');
  assert.equal(alarms[0]!.phase, 'flush');
  assert.match(alarms[0]!.error, /EIO/);
  assert.match((await spool.metrics()).lastFlushError, /EIO/, '指标里要看得见，诊断包据此判断磁盘健康');
});

test('刷盘恢复后 lastFlushError 会被清掉，不会一直挂着旧错误', async () => {
  let brokenDisk = true;
  const spool = await Spool.open({
    dir: freshDir(), flushIntervalMs: 10, fullPolicy: 'drop-oldest',
    fsyncFn: async () => { if (brokenDisk) throw new Error('EIO: i/o error'); },
  });
  await spool.enqueue({ a: 1 });
  for (let i = 0; i < 40 && (await spool.metrics()).lastFlushError === ''; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.match((await spool.metrics()).lastFlushError, /EIO/);

  brokenDisk = false;
  await spool.enqueue({ b: 2 });
  for (let i = 0; i < 40 && (await spool.metrics()).lastFlushError !== ''; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal((await spool.metrics()).lastFlushError, '', '恢复后必须清空，否则告警永远挂着');
  await spool.close();
});

/*
 * 刷盘失败要**重新标脏**：不重标的话，一次失败之后这批数据
 * 就再也不会被尝试刷盘了 —— 磁盘恢复了也永远留在页缓存里。
 */
test('刷盘失败后会重试，不是一失败就放弃', async () => {
  let attempts = 0;
  const spool = await Spool.open({
    dir: freshDir(), flushIntervalMs: 10, fullPolicy: 'drop-oldest',
    fsyncFn: async () => { attempts += 1; if (attempts <= 2) throw new Error('EIO'); },
  });
  await spool.enqueue({ a: 1 });
  for (let i = 0; i < 60 && attempts < 3; i++) await new Promise((r) => setTimeout(r, 15));
  assert.ok(attempts >= 3, `失败后应继续重试，实际只试了 ${attempts} 次`);
  await spool.close();
});

test('缓存写满与落盘失败是两条独立通道，互不顶替', async () => {
  const full: unknown[] = [];
  const werr: unknown[] = [];
  const spool = await Spool.open({
    dir: freshDir(), flushIntervalMs: 10_000, fullPolicy: 'drop-newest',
    maxBytes: 400,
    onFull: (i) => full.push(i), onWriteError: (i) => werr.push(i),
  });
  for (let i = 0; i < 40; i++) await spool.enqueue({ pad: 'z'.repeat(50) });

  assert.ok(full.length > 0, '写满该走 onFull');
  assert.deepEqual(werr, [], '磁盘没坏就不该报落盘失败');
  await spool.close();
});
