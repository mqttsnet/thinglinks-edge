import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { OutageLog } from './outage.ts';

/** 可控时钟：要构造确定的时长，不能靠真实时间 */
function clock(startIso: string) {
  let t = Date.parse(startIso);
  return { now: () => new Date(t).toISOString(), advance: (sec: number) => { t += sec * 1000; } };
}
const fresh = (c = clock('2026-08-28T00:00:00.000Z')) =>
  ({ log: new OutageLog(openDb(':memory:'), c.now), c });

test('没断过时没有进行中的记录', () => {
  const { log } = fresh();
  assert.equal(log.open(), undefined);
  assert.deepEqual(log.recent(), []);
});

test('一次完整断网：三个时刻、两段时长都对', () => {
  const { log, c } = fresh();
  log.begin();
  c.advance(3600);            // 断了 1 小时
  log.restore();
  c.advance(120);             // 补传花了 2 分钟
  const done = log.finish();

  assert.ok(done);
  assert.equal(done.status, 'done');
  assert.equal(done.outageSec, 3600, '断网时长');
  assert.equal(done.recoverySec, 120, '补传耗时');
  assert.ok(done.startedAt && done.restoredAt && done.drainedAt);
});

/*
 * 恢复之后不能直接算 done：那时候积压才刚开始补。
 * 只记断开和恢复，会让人以为一恢复就没事了，而积压可能还要补半小时。
 */
test('链路恢复只是进入 restoring，不是结束', () => {
  const { log } = fresh();
  log.begin();
  const r = log.restore();
  assert.equal(r?.status, 'restoring');
  assert.equal(r?.drainedAt, null);
  assert.equal(r?.recoverySec, null, '还没补完就不该有补传耗时');
  assert.ok(log.open(), '仍算未结束');
});

/*
 * 连接抖动会在几秒内掉线重连好几次。每次都开一条会把列表刷成噪音，
 * 真正那次长断网反而被淹掉。
 */
test('抖动不会刷出一堆记录', () => {
  const { log } = fresh();
  const a = log.begin();
  const b = log.begin();
  const c2 = log.begin();
  assert.equal(a.id, b.id);
  assert.equal(b.id, c2.id);
  assert.equal(log.recent().length, 1);
});

test('峰值取最大，不被后来的小值覆盖', () => {
  const { log } = fresh();
  log.begin();
  log.observePending(50);
  log.observePending(1200);
  log.observePending(30);
  assert.equal(log.open()?.peakPending, 1200, '峰值才代表影响范围');
});

test('计数累加：落缓存、补传、丢弃各自独立', () => {
  const { log } = fresh();
  log.begin();
  log.bump('spooled', 10);
  log.bump('spooled', 5);
  log.bump('replayed', 12);
  log.bump('dropped', 3);
  const cur = log.open()!;
  assert.equal(cur.spooled, 15);
  assert.equal(cur.replayed, 12);
  assert.equal(cur.dropped, 3, '非 0 就是真丢了数据，必须留痕');
});

test('没在断网时，各类更新都是空操作', () => {
  const { log } = fresh();
  log.observePending(100);
  log.bump('spooled', 5);
  assert.equal(log.recent().length, 0, '不该凭空造记录');
  assert.equal(log.restore(), undefined, '首次启动就连上属于正常');
  assert.equal(log.finish(), undefined);
});

test('还没恢复就说补完了：拒绝，不写出读不懂的记录', () => {
  const { log } = fresh();
  log.begin();
  const r = log.finish();
  assert.equal(r?.status, 'ongoing', '状态不该被改成 done');
  assert.equal(r?.drainedAt, null);
});

test('重启后收尾：标注并交回正常流程，不是一直挂着「补传中」', () => {
  const { log, c } = fresh();
  log.begin();
  c.advance(600);
  log.restore();

  const adopted = log.adoptAfterRestart();
  assert.match(adopted!.note, /重启/);
  assert.equal(adopted!.status, 'restoring', '仍交回正常流程，链路一连上就会重新补传');

  c.advance(60);
  assert.equal(log.finish()?.status, 'done', '照常能结束');
});

test('重启标注不会重复叠加成一长串', () => {
  const { log } = fresh();
  log.begin();
  log.adoptAfterRestart();
  const twice = log.adoptAfterRestart();
  assert.equal((twice!.note.match(/重启/g) ?? []).length, 2,
    '两次重启就该有两条，但每次只加一条，不是指数增长');
});

test('最近记录按时间倒序，最新在前', () => {
  const { log, c } = fresh();
  for (let i = 0; i < 3; i++) {
    log.begin(`第 ${i} 次`);
    c.advance(60); log.restore();
    c.advance(10); log.finish();
    c.advance(3600);
  }
  const list = log.recent();
  assert.equal(list.length, 3);
  assert.equal(list[0]!.note, '第 2 次', '最新的排最前');
  assert.ok(Date.parse(list[0]!.startedAt) > Date.parse(list[2]!.startedAt));
});

test('limit 有上下界，不会被传个巨大值拖垮', () => {
  const { log } = fresh();
  assert.doesNotThrow(() => log.recent(0));
  assert.doesNotThrow(() => log.recent(100000));
});
