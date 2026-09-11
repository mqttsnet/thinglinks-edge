import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTime } from './datetime.ts';

// 断言里写死东八区的结果，所以先钉住时区；跑测试的机器时区不该影响结论
process.env.TZ = 'Asia/Shanghai';

test('SQLite 的无时区时间戳按 UTC 解析，不是本地', () => {
  // datetime('now') 存的是 UTC。当成本地会得到 2026/8/27 17:31:26 —— 差 8 小时，
  // 而且格式完全正常，不对着真实时间看根本发现不了
  assert.equal(localTime('2026-08-27 17:31:26'), '2026/8/28 01:31:26');
});

test('带 Z 的 ISO 串照常处理', () => {
  assert.equal(localTime('2026-08-28T01:31:26.000Z'), '2026/8/28 09:31:26');
});

test('空值给破折号而不是 Invalid Date', () => {
  for (const v of ['', null, undefined]) assert.equal(localTime(v), '—');
});

test('解析不出来时原样回显，保住原始信息', () => {
  assert.equal(localTime('不是时间'), '不是时间');
});
