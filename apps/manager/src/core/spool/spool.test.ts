import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool, type FullPolicy } from './spool.ts';

const dir = () => mkdtemp(join(tmpdir(), 'tle-spool-'));
const openSpool = (d: string, over: Record<string, unknown> = {}) =>
  Spool.open({ dir: d, flushIntervalMs: 5, ...over } as never);

/** 收下一切的假出口 */
const sink = () => {
  const got: unknown[] = [];
  return { got, send: async (p: unknown) => { got.push(p); } };
};

test('入队后可原样补传，顺序不变', async () => {
  const d = await dir();
  const s = await openSpool(d);
  for (const n of [1, 2, 3]) assert.equal(await s.enqueue({ n }), 'stored');
  const out = sink();
  assert.deepEqual(await s.replay(out.send), { sent: 3, failed: 0 });
  assert.deepEqual(out.got, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('补传中途断开：已确认的不重发，未确认的不丢', async () => {
  const d = await dir();
  const s = await openSpool(d);
  for (const n of [1, 2, 3, 4]) await s.enqueue({ n });

  const first: unknown[] = [];
  const r1 = await s.replay(async (p) => {
    if (first.length === 2) throw new Error('链路又断了');
    first.push(p);
  });
  assert.deepEqual(r1, { sent: 2, failed: 1 });
  assert.deepEqual(first, [{ n: 1 }, { n: 2 }]);

  const rest = sink();
  const r2 = await s.replay(rest.send);
  assert.equal(r2.sent, 2);
  assert.deepEqual(rest.got, [{ n: 3 }, { n: 4 }], '接着断点续传，不重发前两条');
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('进度落盘 —— 重启后不重发已确认的', async () => {
  const d = await dir();
  let s = await openSpool(d);
  for (const n of [1, 2, 3]) await s.enqueue({ n });
  await s.replay(async () => {}, { maxRecords: 2 });
  await s.close();

  s = await openSpool(d);
  const out = sink();
  await s.replay(out.send);
  assert.deepEqual(out.got, [{ n: 3 }], '重启后只补剩下的那条');
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('整段传完即回收文件', async () => {
  const d = await dir();
  const s = await openSpool(d, { maxSegmentBytes: 40 });
  for (let i = 0; i < 8; i++) await s.enqueue({ i });
  const before = (await s.metrics()).segments;
  assert.ok(before >= 2, `应有多段，实际 ${before}`);
  await s.replay(async () => {});
  const after = await s.metrics();
  assert.ok(after.segments < before, `传完应回收，${before} → ${after.segments}`);
  assert.equal(after.pending, 0);
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('写满策略：丢最旧 —— 腾出空间后新数据仍能写入', async () => {
  const d = await dir();
  const s = await openSpool(d, { maxBytes: 200, maxSegmentBytes: 60, fullPolicy: 'drop-oldest' });
  for (let i = 0; i < 40; i++) await s.enqueue({ i, pad: 'xxxxxxxxxx' });
  const m = await s.metrics();
  assert.ok(m.droppedOldest > 0, '应丢掉过最旧的段');
  // 真实保证是 maxBytes + 一个段：当前写入段删不掉，这是分段结构的固有代价
  assert.ok(m.bytes <= m.maxBytes + 60, `占用应在 上限+一段 内：${m.bytes} > ${m.maxBytes}+60`);
  const out = sink();
  await s.replay(out.send);
  assert.ok(out.got.length > 0, '剩下的仍可补传');
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('写满策略：丢最新 —— 老数据一条不动', async () => {
  const d = await dir();
  const s = await openSpool(d, { maxBytes: 120, maxSegmentBytes: 60, fullPolicy: 'drop-newest' });
  const results: string[] = [];
  for (let i = 0; i < 30; i++) results.push(await s.enqueue({ i, pad: 'xxxxxxxxxx' }));
  assert.ok(results.includes('dropped-newest'), '写满后应丢新的');
  const out = sink();
  await s.replay(out.send);
  assert.deepEqual((out.got[0] as { i: number }).i, 0, '最早那条必须还在');
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('写满策略：停止采集 —— 明确拒收，由上层让现场感知异常', async () => {
  const d = await dir();
  const s = await openSpool(d, { maxBytes: 120, maxSegmentBytes: 60, fullPolicy: 'stop-accepting' });
  const results: string[] = [];
  for (let i = 0; i < 30; i++) results.push(await s.enqueue({ i, pad: 'xxxxxxxxxx' }));
  assert.ok(results.includes('rejected'));
  assert.equal((await s.metrics()).rejected > 0, true);
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('三种策略都不静默丢弃 —— 返回值必须说清发生了什么', async () => {
  for (const policy of ['drop-oldest', 'drop-newest', 'stop-accepting'] as FullPolicy[]) {
    const d = await dir();
    const s = await openSpool(d, { maxBytes: 120, maxSegmentBytes: 60, fullPolicy: policy });
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(await s.enqueue({ i, pad: 'xxxxxxxxxx' }));
    for (const r of seen) {
      assert.ok(['stored', 'dropped-oldest', 'dropped-newest', 'rejected'].includes(r),
                `${policy} 返回了未知结果 ${r}`);
    }
    await s.close();
    await rm(d, { recursive: true, force: true });
  }
});

test('写满告警只在状态翻转时触发一次，不逐条轰炸', async () => {
  const d = await dir();
  const events: boolean[] = [];
  const s = await openSpool(d, {
    maxBytes: 120, maxSegmentBytes: 60, fullPolicy: 'drop-newest',
    onFull: (i: { full: boolean }) => events.push(i.full),
  });
  for (let i = 0; i < 30; i++) await s.enqueue({ i, pad: 'xxxxxxxxxx' });
  assert.equal(events.filter((e) => e).length, 1,
               `进入写满只应告警一次，实际 ${events.filter((e) => e).length} 次`);
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('补传限速生效 —— 不与实时数据抢带宽', async () => {
  const d = await dir();
  const s = await openSpool(d);
  for (let i = 0; i < 5; i++) await s.enqueue({ i });
  const t0 = Date.now();
  await s.replay(async () => {}, { ratePerSec: 100 });   // 每条间隔 10ms
  const spent = Date.now() - t0;
  assert.ok(spent >= 35, `限速应拉长耗时，实际 ${spent}ms`);
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('指标反映占用与剩余', async () => {
  const d = await dir();
  const s = await openSpool(d, { maxBytes: 10_000 });
  for (let i = 0; i < 10; i++) await s.enqueue({ i });
  const m = await s.metrics();
  assert.equal(m.pending, 10);
  assert.ok(m.bytes > 0 && m.usagePercent > 0 && m.usagePercent < 100);
  assert.equal(m.policy, 'drop-oldest');
  await s.close();
  await rm(d, { recursive: true, force: true });
});

test('空 spool 补传是无操作，不报错', async () => {
  const d = await dir();
  const s = await openSpool(d);
  assert.deepEqual(await s.replay(async () => {}), { sent: 0, failed: 0 });
  await s.close();
  await rm(d, { recursive: true, force: true });
});
