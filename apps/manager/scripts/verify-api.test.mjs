import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  allocateMappedPort,
  isFreshLogEvent,
  portIsUsable,
  preview,
  requireCheck,
} from './verify-api.mjs';

test('实例创建失败是终止后续验证的关键前置条件', () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.throws(
      () => requireCheck('创建实例返回 201', false, 'HTTP 400 · bootstrap fixture missing'),
      /创建实例返回 201未通过：HTTP 400 · bootstrap fixture missing/,
    );
  } finally {
    console.log = originalLog;
  }
});

test('缺失的云载荷诊断不会对 undefined 直接调用 slice', () => {
  assert.equal(preview(undefined), 'undefined');

  const circular = {};
  circular.self = circular;
  assert.equal(preview(circular), '[object Object]');
});

test('映射端口避开 Manager、Admin bridge 及相邻端口', () => {
  assert.equal(portIsUsable(42000, [41000, 43000]), true);
  assert.equal(portIsUsable(42000, [42000]), false);
  assert.equal(portIsUsable(42000, [41999]), false);
  assert.equal(portIsUsable(42000, [42001]), false);
  assert.equal(portIsUsable(29999, []), false);
  assert.equal(portIsUsable(61000, []), false);
});

test('映射端口只在允许范围内探测并跳过已占用候选', async () => {
  const candidates = [29999, 42000, 42001, 43000];
  const probed = [];
  const selected = await allocateMappedPort([42000], {
    nextCandidate: () => candidates.shift(),
    canBind: async (port) => {
      probed.push(port);
      return port === 43000;
    },
  });

  assert.equal(selected, 43000);
  assert.deepEqual(probed, [43000]);
});

test('SSE follow 以事件时间判断新日志，不绑定 Node-RED 英文措辞', () => {
  const actionAt = Date.parse('2026-09-03T09:02:18.500Z');
  assert.equal(isFreshLogEvent({ id: '2026-09-03T09:02:18.877920888Z' }, actionAt), true);
  assert.equal(isFreshLogEvent({ id: '2026-09-03T09:02:17.400000000Z' }, actionAt), false);
  assert.equal(isFreshLogEvent({ id: 'not-a-time' }, actionAt), false);
});

test('缺镜像用例使用本次 invocation 随机 tag 并先确认不存在', () => {
  const source = readFileSync(new URL('./verify-api.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /const MISSING_TAG = '0\.0\.0-never-published'/);
  assert.match(source, /MISSING_TAG = `0\.0\.0-missing-\$\{identity\.invocation\}`/);
  assert.match(source,
    /assertImageReferenceAbsent\(activeFixture\.raw, `nodered\/node-red:\$\{MISSING_TAG\}`\)/);
});
