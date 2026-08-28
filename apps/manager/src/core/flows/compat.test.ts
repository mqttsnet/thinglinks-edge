import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompatibility } from './compat.ts';

test('目标实例缺节点类型时列出缺哪些', () => {
  const r = checkCompatibility(['mqtt in', 'modbus-read', 'function'], ['mqtt in', 'function']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['modbus-read']);
});

/*
 * tab / subflow 是 Node-RED 的结构类型，不由任何节点模块提供，
 * 因此不会出现在 /nodes 的清单里。拿它们比对必然「缺失」——那是假警报，
 * 一旦出现，用户会以为每个模板都不兼容，从此不再看这个提示。
 */
test('tab 与 subflow 不算缺失，否则每个模板都会误报', () => {
  const r = checkCompatibility(['tab', 'subflow', 'subflow:abc123', 'function'], ['function']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('全都装了就是兼容', () => {
  const r = checkCompatibility(['function'], ['function', 'debug']);
  assert.equal(r.ok, true);
});

test('查成了要留下痕迹：checked 为 true', () => {
  // 没有这个字段，「查过、齐全」和「没查成、按默认放行」在响应里长得一模一样，
  // 界面只好把后者也显示成绿色的「节点齐全」
  assert.equal(checkCompatibility(['debug'], ['debug']).checked, true);
  assert.equal(checkCompatibility(['nope'], ['debug']).checked, true);
});
