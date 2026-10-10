import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeviceHttpForm, deviceIngressUrl } from './device-http-config.ts';

test('device ingress URL retains the deployment prefix and encodes the binding identity', () => {
  assert.equal(deviceIngressUrl('meter-a', '/edge', 'https://gateway.example'), 'https://gateway.example/edge/api/device-ingress/meter-a');
});

test('blank or cleared numeric fields cannot silently become a default in the submitted binding', () => {
  const valid = { id: 'meter-a', deviceId: 'meter-a', targetPath: '/red/line-a/api/telemetry', maxBodyBytes: 1048576, rateLimitPerMinute: 60 };
  assert.equal(validateDeviceHttpForm(valid, '/red/line-a/'), '');
  assert.match(validateDeviceHttpForm({ ...valid, rateLimitPerMinute: null }, '/red/line-a/'), /请求上限/);
  assert.match(validateDeviceHttpForm({ ...valid, maxBodyBytes: null }, '/red/line-a/'), /请求体/);
  assert.match(validateDeviceHttpForm({ ...valid, id: '设备' }, '/red/line-a/'), /ID/);
  assert.match(validateDeviceHttpForm({ ...valid, targetPath: '/red/line-b/api/telemetry' }, '/red/line-a/'), /路径/);
  assert.match(validateDeviceHttpForm({ ...valid, targetPath: '/red/line-a/api/%2e%2e/flows' }, '/red/line-a/'), /路径/);
});
