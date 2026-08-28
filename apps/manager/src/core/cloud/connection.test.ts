import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConnection, connectionOptions, DEFAULT_CONNECTION, ConnectionConfigError,
} from './connection.ts';

test('默认值等于这几项写死在 gateway 里时的那一组 —— 升级不改运行行为', () => {
  assert.deepEqual(DEFAULT_CONNECTION, {
    mqttVersion: 5,
    keepaliveSec: 60,
    connectTimeoutSec: 15,
    autoReconnect: true,
    reconnectPeriodMs: 5_000,
  });
});

test('一个字段都不传 = 一个字段都不改', () => {
  const prev = { ...DEFAULT_CONNECTION, mqttVersion: 4 as const, keepaliveSec: 30 };
  assert.deepEqual(normalizeConnection(undefined, prev), prev);
  assert.deepEqual(normalizeConnection({}, prev), prev);
});

test('只改一项时，其余沿用旧值', () => {
  const prev = { ...DEFAULT_CONNECTION, keepaliveSec: 30, reconnectPeriodMs: 4_000 };
  const next = normalizeConnection({ mqttVersion: 4 }, prev);
  assert.equal(next.mqttVersion, 4);
  assert.equal(next.keepaliveSec, 30, '没传的心跳该保持原值');
  assert.equal(next.reconnectPeriodMs, 4_000);
});

test('MQTT 版本只认 3 / 4 / 5', () => {
  for (const v of [3, 4, 5] as const) {
    assert.equal(normalizeConnection({ mqttVersion: v }).mqttVersion, v);
  }
  assert.throws(
    () => normalizeConnection({ mqttVersion: 311 as never }),
    (e: Error) => e instanceof ConnectionConfigError && /3\.1\.1/.test(e.message),
  );
});

test('心跳 0 合法（不发心跳），超过协议 16 位上限被拒', () => {
  assert.equal(normalizeConnection({ keepaliveSec: 0 }).keepaliveSec, 0);
  assert.equal(normalizeConnection({ keepaliveSec: 65535 }).keepaliveSec, 65535);
  assert.throws(() => normalizeConnection({ keepaliveSec: 65536 }), /心跳间隔/);
  assert.throws(() => normalizeConnection({ keepaliveSec: -1 }), /心跳间隔/);
  assert.throws(() => normalizeConnection({ keepaliveSec: 30.5 }), /整数/);
});

test('连接超时与重连周期都有范围，挡住「填了个不会生效的值」', () => {
  assert.throws(() => normalizeConnection({ connectTimeoutSec: 0 }), /连接超时/);
  assert.throws(() => normalizeConnection({ connectTimeoutSec: 301 }), /连接超时/);
  // 10 毫秒重连在断网时只会空转
  assert.throws(() => normalizeConnection({ reconnectPeriodMs: 10 }), /重连周期/);
  assert.throws(() => normalizeConnection({ reconnectPeriodMs: 300_001 }), /重连周期/);
  assert.equal(normalizeConnection({ reconnectPeriodMs: 4_000 }).reconnectPeriodMs, 4_000);
});

test('落到 mqtt.js：5.0 不带 protocolId，3.1 必须带 MQIsdp', () => {
  const v5 = connectionOptions({ ...DEFAULT_CONNECTION, mqttVersion: 5 });
  assert.equal(v5['protocolVersion'], 5);
  assert.equal('protocolId' in v5, false, '5.0 带上 protocolId 反而不对');

  const v4 = connectionOptions({ ...DEFAULT_CONNECTION, mqttVersion: 4 });
  assert.equal('protocolId' in v4, false);

  // 3.1 的协议名是 MQIsdp；少了它 broker 会在 CONNECT 阶段拒掉，
  // 而报错只说「连接被拒」，看不出是协议名不对
  const v3 = connectionOptions({ ...DEFAULT_CONNECTION, mqttVersion: 3 });
  assert.equal(v3['protocolVersion'], 3);
  assert.equal(v3['protocolId'], 'MQIsdp');
});

test('秒转毫秒只在落给 mqtt.js 时发生，存的一直是秒', () => {
  const opts = connectionOptions({ ...DEFAULT_CONNECTION, connectTimeoutSec: 10 });
  assert.equal(opts['connectTimeout'], 10_000);
});

test('关掉自动重连 = 把间隔设成 0（mqtt.js 没有单独的开关）', () => {
  const off = connectionOptions({ ...DEFAULT_CONNECTION, autoReconnect: false, reconnectPeriodMs: 4_000 });
  assert.equal(off['reconnectPeriod'], 0);
  const on = connectionOptions({ ...DEFAULT_CONNECTION, autoReconnect: true, reconnectPeriodMs: 4_000 });
  assert.equal(on['reconnectPeriod'], 4_000);
});
