/**
 * 补传调度测试。
 *
 * 核心是那条**真实漏洞**的回归：链路恢复后若没有新数据上报，
 * 积压曾经会永远滞留。这里三个触发口各测一遍，外加单飞与限速。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from './spool.ts';
import { SpoolDrainer } from './drainer.ts';

const freshSpool = () => Spool.open({
  dir: join(mkdtempSync(join(tmpdir(), 'tle-drain-')), 'spool'),
  flushIntervalMs: 5, fullPolicy: 'drop-oldest',
});

/** 造一个可控的链路：ready 与 send 都能随时切换 */
function harness(spool: Spool, over: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const state = { up: false };
  const drainer = new SpoolDrainer({
    spool,
    ready: () => state.up,
    send: async (p) => {
      if (!state.up) throw new Error('链路未就绪');
      sent.push(p);
    },
    ratePerSec: 0,          // 测试不限速，否则跑得太慢
    intervalMs: 60,
    ...over,
  });
  return { drainer, sent, state };
}

test('链路没好时连试都不试', async () => {
  const spool = await freshSpool();
  await spool.enqueue({ a: 1 });
  const { drainer, sent } = harness(spool);
  const r = await drainer.trigger('manual');
  assert.deepEqual(r, { sent: 0, failed: 0 });
  assert.equal(sent.length, 0);
  assert.equal((await spool.metrics()).pending, 1, '数据要留着，不能因为试不了就丢');
  await spool.close();
});

/*
 * 这条是整个模块存在的理由：**链路恢复的那一刻就该补**，
 * 不必等下一条业务数据。原先只有「发送成功后」一个触发口，
 * 夜班停机时积压会一直挂着而界面显示「已连接」。
 */
test('链路恢复触发补传 —— 不需要任何新数据', async () => {
  const spool = await freshSpool();
  for (const i of [1, 2, 3]) await spool.enqueue({ i });
  const { drainer, sent, state } = harness(spool);

  state.up = true;                       // 链路恢复
  await drainer.trigger('link-online');  // 没有任何新数据进来

  assert.equal(sent.length, 3);
  assert.equal((await spool.metrics()).pending, 0);
  await spool.close();
});

test('定时兜底也能把积压补完', async () => {
  const spool = await freshSpool();
  await spool.enqueue({ a: 1 });
  const { drainer, sent, state } = harness(spool, { intervalMs: 30 });
  state.up = true;
  drainer.start();
  for (let i = 0; i < 40 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  drainer.stop();
  assert.equal(sent.length, 1, '定时器应当自己把积压带出去');
  await spool.close();
});

test('stop 之后不再触发', async () => {
  const spool = await freshSpool();
  const { drainer, sent, state } = harness(spool, { intervalMs: 20 });
  state.up = true;
  drainer.start();
  drainer.stop();
  await spool.enqueue({ a: 1 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 0);
  await spool.close();
});

/*
 * 单飞很关键：链路恢复的瞬间三个触发口可能同时到，
 * 排队执行会连着跑好几轮，正好把刚恢复的链路再压垮一次。
 */
test('并发触发只跑一轮，不排队不叠加', async () => {
  const spool = await freshSpool();
  for (let i = 0; i < 10; i++) await spool.enqueue({ i });
  let inFlight = 0;
  let maxInFlight = 0;
  const { drainer, state } = harness(spool, {
    send: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    },
  });
  state.up = true;
  await Promise.all([drainer.trigger('after-send'), drainer.trigger('link-online'),
                     drainer.trigger('interval')]);
  assert.equal(maxInFlight, 1, '同一时刻只该有一轮在跑');
  await spool.close();
});

test('单轮有上限，不会一次性把积压全冲出去', async () => {
  const spool = await freshSpool();
  for (let i = 0; i < 20; i++) await spool.enqueue({ i });
  const { drainer, sent, state } = harness(spool, { maxRecords: 5 });
  state.up = true;
  await drainer.trigger('manual');
  assert.equal(sent.length, 5);
  assert.equal((await spool.metrics()).pending, 15, '剩下的留给下一轮');
  await spool.close();
});

test('补传中途链路又断，保住进度等下次；恢复后不重发已送的', async () => {
  const spool = await freshSpool();
  for (let i = 0; i < 6; i++) await spool.enqueue({ i });
  const sent: number[] = [];
  const state = { up: true, breakAfter: 3 };
  const drainer = new SpoolDrainer({
    spool, ready: () => state.up, ratePerSec: 0,
    send: async (p) => {
      if (sent.length >= state.breakAfter) throw new Error('链路又断了');
      sent.push((p as { i: number }).i);
    },
  });

  await drainer.trigger('manual');
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal((await spool.metrics()).pending, 3, '没发出去的必须留着');

  // 链路好了：放开限制再补一轮
  state.breakAfter = Infinity;
  const r2 = await drainer.trigger('link-online');
  assert.equal(r2.sent, 3);
  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5], '要从第 4 条接着来，不能重发前 3 条');
  assert.equal(new Set(sent).size, sent.length, '不允许重复');
  assert.equal((await spool.metrics()).pending, 0);
  await spool.close();
});

test('每轮结果可见：谁触发的、发了几条', async () => {
  const spool = await freshSpool();
  await spool.enqueue({ a: 1 });
  const rounds: unknown[] = [];
  const state = { up: true };
  const drainer = new SpoolDrainer({
    spool, ready: () => state.up, send: async () => {}, ratePerSec: 0,
    onRound: (r) => rounds.push(r),
  });
  await drainer.trigger('link-online');
  assert.equal(rounds.length, 1);
  const r0 = rounds[0] as { sent: number; failed: number; trigger: string; elapsedMs: number };
  assert.equal(r0.sent, 1);
  assert.equal(r0.failed, 0);
  assert.equal(r0.trigger, 'link-online');
  assert.ok(typeof r0.elapsedMs === 'number', '要带耗时，否则算不出补传速率');
  assert.equal(drainer.lastRound?.trigger, 'link-online');
  assert.ok(drainer.lastRound?.at, '要有时间戳，否则看不出补传是否还在推进');
  await spool.close();
});

test('空积压时不产生噪音回调', async () => {
  const spool = await freshSpool();
  const rounds: unknown[] = [];
  const state = { up: true };
  const drainer = new SpoolDrainer({
    spool, ready: () => state.up, send: async () => {}, ratePerSec: 0,
    onRound: (r) => rounds.push(r),
  });
  await drainer.trigger('interval');
  assert.deepEqual(rounds, [], '没东西可补就不该回调，否则日志每分钟一条噪音');
  await spool.close();
});

// ── 补传进度与预计完成时间 ──────────────────────────

/*
 * 这一组的核心不是「算得准」，是**不知道的时候要说不知道**。
 * 现场看到「预计 3 分钟」然后等了半小时，下次就再也不信这个读数了 ——
 * 一个不可信的估计比没有估计更糟。
 */
test('没有待补传数据时不给 eta，并说明原因', async () => {
  const spool = await freshSpool();
  const { drainer, state } = harness(spool);
  state.up = true;
  const p = drainer.progress(0);
  assert.equal(p.etaSec, null);
  assert.match(p.reason, /没有待补传/);
  await spool.close();
});

test('链路没恢复时不给 eta —— 补传根本没开始', async () => {
  const spool = await freshSpool();
  const { drainer } = harness(spool);     // state.up 默认 false
  const p = drainer.progress(100);
  assert.equal(p.etaSec, null);
  assert.equal(p.ratePerSec, null);
  assert.match(p.reason, /链路未恢复/);
  await spool.close();
});

test('还没补过时不给 eta，不拿配置里的限速冒充实测速率', async () => {
  const spool = await freshSpool();
  const { drainer, state } = harness(spool);
  state.up = true;
  const p = drainer.progress(100);
  assert.equal(p.etaSec, null);
  assert.match(p.reason, /还没有补传样本/);
  await spool.close();
});

test('补过之后按实测速率给出 eta', async () => {
  const spool = await freshSpool();
  for (let i = 0; i < 30; i++) await spool.enqueue({ i });
  const { drainer, state } = harness(spool, {
    maxRecords: 10,
    send: async () => { await new Promise((r) => setTimeout(r, 2)); },
  });
  state.up = true;
  await drainer.trigger('manual');          // 补 10 条，产生速率样本

  const pending = (await spool.metrics()).pending;
  const p = drainer.progress(pending);
  assert.ok(p.ratePerSec !== null && p.ratePerSec > 0, `应有实测速率，实际 ${p.ratePerSec}`);
  assert.ok(p.etaSec !== null && p.etaSec > 0, `应给出 eta，实际 ${p.etaSec}`);
  assert.equal(p.reason, '', '有 eta 时不该再带原因');
  assert.equal(p.pending, pending);
  await spool.close();
});

test('空轮不计入速率 —— 否则速率会被算到天上', async () => {
  const spool = await freshSpool();
  const { drainer, state } = harness(spool);
  state.up = true;
  await drainer.trigger('interval');        // 没东西可补，是空轮
  const p = drainer.progress(50);
  assert.equal(p.ratePerSec, null, '空轮不该产生速率样本');
  assert.match(p.reason, /还没有补传样本/);
  await spool.close();
});
