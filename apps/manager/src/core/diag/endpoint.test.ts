import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEndpoint } from './endpoint.ts';

test('parseEndpoint 按 scheme 补默认端口', () => {
  assert.deepEqual(parseEndpoint('mqtts://broker.example.com'), { host: 'broker.example.com', port: 8883 });
  assert.deepEqual(parseEndpoint('mqtt://broker.example.com'), { host: 'broker.example.com', port: 1883 });
  assert.deepEqual(parseEndpoint('mqtt://broker.example.com:11883'), { host: 'broker.example.com', port: 11883 });
  assert.deepEqual(parseEndpoint('https://portal.example.com'), { host: 'portal.example.com', port: 443 });
  assert.deepEqual(parseEndpoint('10.0.0.5:502'), { host: '10.0.0.5', port: 502 });
  assert.deepEqual(parseEndpoint('[::1]:1883'), { host: '::1', port: 1883 });
});

test('parseEndpoint 拒绝说不清端口的输入', () => {
  assert.throws(() => parseEndpoint(''), /不能为空/);
  assert.throws(() => parseEndpoint('broker.example.com'), /格式不对/);
  assert.throws(() => parseEndpoint('10.0.0.5:70000'), /端口越界/);
});
