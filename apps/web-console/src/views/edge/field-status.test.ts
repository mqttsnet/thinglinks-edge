import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldDeviceStatus } from './field-status.ts';

test('a stopped instance overrides a device that last reported online without changing its record', () => {
  const device = Object.freeze({ online: true, lastSeen: '2026-09-09T14:00:00.000Z' });
  const status = fieldDeviceStatus(device, { state: 'exited', running: false });
  assert.deepEqual(status, { online: false, label: '实例已停止', instanceUnavailable: true });
  assert.equal(device.online, true);
  assert.equal(device.lastSeen, '2026-09-09T14:00:00.000Z');
});

test('known states that cannot collect explain why the device is not shown online', () => {
  for (const [state, label] of [
    ['created', '实例未启动'], ['paused', '实例已暂停'], ['restarting', '实例重启中'],
    ['missing', '实例不可用'], ['dead', '实例不可用'], ['removing', '实例移除中'],
  ] as const) {
    assert.deepEqual(fieldDeviceStatus({ online: true }, { state, running: false }), {
      online: false, label, instanceUnavailable: true,
    });
  }
});

test('running instances keep the actual registered online and offline state', () => {
  for (const online of [true, false]) {
    assert.deepEqual(fieldDeviceStatus({ online }, { state: 'running', running: true }), {
      online, label: online ? '在线' : '离线', instanceUnavailable: false,
    });
  }
});

test('missing or unconfirmed instance information does not invent a stopped state or time threshold', () => {
  for (const instance of [undefined, { state: 'unknown', running: false }]) {
    assert.deepEqual(fieldDeviceStatus({ online: true }, instance), {
      online: true, label: '在线', instanceUnavailable: false,
    });
  }
});

test('the visible online total excludes stopped instances and recovers from fresh running state', () => {
  const devices = [{ online: true }, { online: true }, { online: false }];
  const stopped = { state: 'exited', running: false };
  const running = { state: 'running', running: true };
  const count = (first: typeof stopped) => devices
    .map((device, index) => fieldDeviceStatus(device, index === 0 ? first : running))
    .filter((status) => status.online).length;
  assert.equal(count(stopped), 1);
  assert.equal(count(running), 2);
});
