import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicroBatcher, BatchOverflowError, groupPoints, DEFAULT_LIMITS, type UplinkPoint, type DataReportPayload } from './batch.ts';

const pt = (over: Partial<UplinkPoint> = {}): UplinkPoint => ({
  deviceId: 'plc-1', serviceCode: 'env', data: { t: 1 }, eventTime: 1000, ...over,
});

/** 手动时钟：定时器不真的等，测试里显式触发 */
function manualTimers() {
  let pending: (() => void) | undefined;
  let lastMs = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { pending = fn; lastMs = ms; return 1; },
    clearTimer: () => { pending = undefined; },
    fire: () => { const f = pending; pending = undefined; f?.(); },
    get armed() { return pending !== undefined; },
    get ms() { return lastMs; },
  };
}

function collector() {
  const batches: { payload: DataReportPayload; points: UplinkPoint[] }[] = [];
  return {
    batches,
    flush: async (payload: DataReportPayload, points: UplinkPoint[]) => { batches.push({ payload, points }); },
  };
}

test('默认阈值就是 08 号文定的三个数，外加一条队列水位上限', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    /*
     * maxPoints 2026-08-28 从 500 调到 2000，08 号文第 2 节同步更新过。
     * 依据是实测：分组后一个点约 19 字节，500 点才 9.3 KB，
     * 而字节预算 256 KB —— 点数限制远早于字节限制触发，白白把上行切成小包。
     * 上行串行（QoS 1 等 PUBACK），包越小往返越多，吞吐被 RTT 除。
     */
    windowMs: 200, maxPoints: 2000, maxBytes: 256 * 1024,
    // 队列上限不是 08 号文的三个触发条件，是为了不让云端卡住时把内存排爆
    maxQueuedBatches: 8, maxQueuedBytes: 2 * 1024 * 1024,
  });
});

test('时间窗到点才发，未到点不发', async () => {
  const t = manualTimers();
  const c = collector();
  const b = new MicroBatcher({ flush: c.flush, setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.add(pt());
  b.add(pt({ data: { t: 2 }, eventTime: 1001 }));
  assert.equal(c.batches.length, 0, '窗口未到不该发');
  assert.equal(t.ms, 200);
  t.fire();
  await b.flushNow();
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0]!.points.length, 2);
});

test('时间窗从本批第一个点开始算，不被后续点重置', () => {
  const t = manualTimers();
  const b = new MicroBatcher({ flush: collector().flush, setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.add(pt());
  const armedAfterFirst = t.armed;
  b.add(pt());
  b.add(pt());
  // 每来一个点就重设定时器的话，持续来点会让它永远不触发，实时性上限就没了
  assert.ok(armedAfterFirst && t.armed, '定时器应保持第一次装的那个');
});

test('条数达标立刻发，不等窗口', async () => {
  const t = manualTimers();
  const c = collector();
  const b = new MicroBatcher({ limits: { maxPoints: 3 }, flush: c.flush, setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.add(pt()); b.add(pt()); 
  assert.equal(c.batches.length, 0);
  b.add(pt());
  await b.flushNow();
  assert.equal(c.batches.length, 1);
  assert.equal(c.batches[0]!.points.length, 3);
  assert.ok(!t.armed, '发完应撤掉定时器');
});

test('字节数达标立刻发', async () => {
  const c = collector();
  const b = new MicroBatcher({ limits: { maxBytes: 200, maxPoints: 10_000 }, flush: c.flush,
                               setTimer: () => 1, clearTimer: () => {} });
  const big = pt({ data: { blob: 'x'.repeat(150) } });
  b.add(big);
  await b.flushNow();
  assert.equal(c.batches.length, 1, '单点就超阈值时应立即发');
});

test('分组：同设备同服务同时刻合并 data', () => {
  const p = groupPoints([
    pt({ data: { temp: 21 } }),
    pt({ data: { humi: 63 } }),
  ]);
  assert.equal(p.devices.length, 1);
  assert.equal(p.devices[0]!.services.length, 1, '同时刻应合并为一条服务记录');
  assert.deepEqual(p.devices[0]!.services[0]!.data, { temp: 21, humi: 63 });
});

test('分组：eventTime 不同绝不合并 —— 合并会把时间序抹平', () => {
  const p = groupPoints([
    pt({ data: { temp: 21 }, eventTime: 1000 }),
    pt({ data: { temp: 22 }, eventTime: 1200 }),
  ]);
  assert.equal(p.devices[0]!.services.length, 2);
  assert.deepEqual(p.devices[0]!.services.map((s) => s.eventTime), [1000, 1200]);
});

test('分组：多子设备 x 多服务，结构对齐云侧 DTO', () => {
  const p = groupPoints([
    pt({ deviceId: 'plc-1', serviceCode: 'env', data: { t: 1 } }),
    pt({ deviceId: 'plc-1', serviceCode: 'power', data: { kw: 3 } }),
    pt({ deviceId: 'plc-2', serviceCode: 'env', data: { t: 5 } }),
  ]);
  assert.deepEqual(p.devices.map((d) => d.deviceId), ['plc-1', 'plc-2'], '设备顺序按首次出现');
  assert.deepEqual(p.devices[0]!.services.map((s) => s.serviceCode), ['env', 'power']);
  const svc = p.devices[1]!.services[0]!;
  assert.deepEqual(Object.keys(svc).sort(), ['data', 'eventTime', 'serviceCode']);
});

test('聚合效果：500 个点聚成 1 条消息', async () => {
  const c = collector();
  const b = new MicroBatcher({ flush: c.flush, setTimer: () => 1, clearTimer: () => {} });
  for (let i = 0; i < 500; i++) b.add(pt({ tagId: `t${i}`, data: { [`t${i}`]: i } } as never));
  await b.flushNow();
  assert.equal(c.batches.length, 1, '500 点应聚成一条，而不是 500 条');
  assert.equal(c.batches[0]!.points.length, 500);
});

test('发送串行，不并发压垮云端', async () => {
  const order: string[] = [];
  let resolveFirst: (() => void) | undefined;
  const b = new MicroBatcher({
    limits: { maxPoints: 1 },
    setTimer: () => 1, clearTimer: () => {},
    flush: async (_p, points) => {
      const tag = String(points[0]!.data['n']);
      order.push(`start-${tag}`);
      if (tag === '1') await new Promise<void>((r) => { resolveFirst = r; });
      order.push(`end-${tag}`);
    },
  });
  b.add(pt({ data: { n: 1 } }));
  b.add(pt({ data: { n: 2 } }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start-1'], '第一批未完成前不该开始第二批');
  resolveFirst!();
  await b.flushNow();
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('发送失败不吞掉：回调拿得到原始点位，好入 spool', async () => {
  const failed: UplinkPoint[][] = [];
  const b = new MicroBatcher({
    limits: { maxPoints: 1 }, setTimer: () => 1, clearTimer: () => {},
    flush: async () => { throw new Error('网关未连接'); },
    onFlushError: (_e, points) => failed.push(points),
  });
  b.add(pt({ data: { n: 9 } }));
  await b.flushNow();
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0]![0]!.data, { n: 9 });
});

test('关闭时把手里的点发完，不静默丢弃', async () => {
  const c = collector();
  const b = new MicroBatcher({ flush: c.flush, setTimer: () => 1, clearTimer: () => {} });
  b.add(pt());
  await b.close();
  assert.equal(c.batches.length, 1);
  assert.throws(() => b.add(pt()), /已关闭/);
});

test('空批次不产生空消息', async () => {
  const c = collector();
  const b = new MicroBatcher({ flush: c.flush, setTimer: () => 1, clearTimer: () => {} });
  await b.flushNow();
  await b.close();
  assert.equal(c.batches.length, 0);
});

// ── 队列水位（一个实例不能拖垮共享 Manager）──────────────────

test('云端卡住时队列到顶就拒收，而不是无限排队', async () => {
  let release: (() => void) | undefined;
  const b = new MicroBatcher({
    limits: { maxPoints: 1, maxQueuedBatches: 2 },
    // flush 一直不返回，模拟云端 TCP 卡住（不是断开 —— 断开会立刻抛错）
    flush: () => new Promise<void>((r) => { release = r; }),
  });

  b.add(pt());                       // 第 1 批：立刻发，占用一个水位
  b.add(pt({ eventTime: 2 }));       // 第 2 批：排队
  assert.equal(b.queued, 2);
  assert.ok(b.saturated, '到顶了');

  assert.throws(() => b.add(pt({ eventTime: 3 })), BatchOverflowError);
  assert.equal(b.rejected, 1, '拒收要计数，否则现场查不出数据为什么少了');
  assert.equal(b.queued, 2, '拒收不占水位');

  release?.();
});

test('发送完成后水位退回，能继续收', async () => {
  const b = new MicroBatcher({
    limits: { maxPoints: 1, maxQueuedBatches: 1 },
    flush: async () => {},
  });
  b.add(pt());
  await b.flushNow();
  assert.equal(b.queued, 0);
  assert.equal(b.saturated, false);
  b.add(pt({ eventTime: 9 }));       // 不该抛
});

test('flush 抛错也要退水位，否则队列永久假满', async () => {
  const errors: Error[] = [];
  const b = new MicroBatcher({
    limits: { maxPoints: 1, maxQueuedBatches: 1 },
    flush: async () => { throw new Error('云端拒绝'); },
    onFlushError: (e) => errors.push(e),
  });
  b.add(pt());
  await b.flushNow();
  assert.equal(errors.length, 1);
  assert.equal(b.queued, 0, '错误路径同样要把水位退回来');
  assert.equal(b.saturated, false);
});

test('字节水位也算数：批次大就更早到顶', async () => {
  let release: (() => void) | undefined;
  const b = new MicroBatcher({
    limits: { maxPoints: 1, maxQueuedBatches: 99, maxQueuedBytes: 1 },
    flush: () => new Promise<void>((r) => { release = r; }),
  });
  b.add(pt());
  assert.ok(b.queuedBytes > 1);
  assert.ok(b.saturated, '字节数已过线');
  assert.throws(() => b.add(pt({ eventTime: 5 })), BatchOverflowError);
  release?.();
});
