import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanDuration, summarizeOutage, summarizeReplay } from './outage-format.ts';
import type { OutageRecord } from '../../api/types.ts';

const rec = (over: Partial<OutageRecord> = {}): OutageRecord => ({
  id: 1, startedAt: '2026-08-28T00:00:00Z', restoredAt: '2026-08-28T01:00:00Z',
  drainedAt: '2026-08-28T01:02:00Z', outageSec: 3600, recoverySec: 120,
  peakPending: 500, spooled: 500, replayed: 500, dropped: 0, status: 'done', note: '',
  ...over,
});

test('时长一律带单位 —— 光看数字分不清秒还是分钟', () => {
  assert.equal(humanDuration(45), '45 秒');
  assert.equal(humanDuration(60), '1 分钟');
  assert.equal(humanDuration(125), '2 分 5 秒');
  assert.equal(humanDuration(3600), '1 小时');
  assert.equal(humanDuration(5400), '1 小时 30 分');
  assert.equal(humanDuration(null), '—');
});

/*
 * 丢数据是这张表里唯一需要人立刻处理的事。
 * 压在时长后面会被略过，所以必须排最前并标红。
 */
test('丢过数据的记录标红，且丢弃条数排在最前', () => {
  const v = summarizeOutage(rec({ dropped: 12 }));
  assert.equal(v.tone, 'error');
  assert.match(v.text, /^丢弃 12 条/);
});

test('断网中与补传中是不同的措辞与颜色', () => {
  const ongoing = summarizeOutage(rec({ status: 'ongoing', restoredAt: null, outageSec: null }));
  assert.equal(ongoing.tone, 'error');
  assert.match(ongoing.text, /断网中/);

  const restoring = summarizeOutage(rec({ status: 'restoring', drainedAt: null, recoverySec: null }));
  assert.equal(restoring.tone, 'warning');
  assert.match(restoring.text, /补传中/);
  assert.ok(!/断网中/.test(restoring.text), '已经连上了就不该再说断网中');
});

test('完成的记录给出两段时长与补回条数', () => {
  const v = summarizeOutage(rec());
  assert.equal(v.tone, 'success');
  assert.match(v.text, /断网 1 小时/);
  assert.match(v.text, /补传 2 分钟/);
  assert.match(v.text, /500 条已补回/);
});

/*
 * 没有 eta 时要照原样说出原因。「链路未恢复」和「还没有补传样本」
 * 对现场是完全不同的两件事，替换成「计算中」等于把信息抹掉。
 */
test('没有 eta 时保留后端给的具体原因', () => {
  assert.match(
    summarizeReplay({ pending: 50, ratePerSec: null, etaSec: null, running: false,
                      reason: '链路未恢复，补传尚未开始' }),
    /链路未恢复/);
  assert.match(
    summarizeReplay({ pending: 50, ratePerSec: null, etaSec: null, running: true,
                      reason: '还没有补传样本，无法估计' }),
    /还没有补传样本/);
});

test('有 eta 时给出速率与剩余时间', () => {
  const t = summarizeReplay({ pending: 600, ratePerSec: 50, etaSec: 12, running: true, reason: '' });
  assert.match(t, /待补传 600 条/);
  assert.match(t, /50 条\/秒/);
  assert.match(t, /12 秒/);
});

test('没有积压时不说预计，也不报错', () => {
  assert.equal(summarizeReplay({ pending: 0, ratePerSec: null, etaSec: null, running: false,
                                 reason: '没有待补传数据' }), '没有待补传数据');
  assert.equal(summarizeReplay(null), '补传状态不可用');
});
