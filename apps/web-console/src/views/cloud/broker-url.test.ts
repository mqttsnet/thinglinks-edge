/**
 * Broker 地址拆拼的测试 —— web-console 的第一批单测。
 *
 * 挑这段先测，是因为它的错**不会报错**：拆错或拼错只表现为「地址看着对、
 * 就是连不上」，而界面上四个格子各自看都正常。往返一致性最值得钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBroker, joinBroker, isWs, isSecure, portOnSchemeChange, pathOnSchemeChange, defaultBroker,
} from './broker-url.ts';

test('四种协议都能拆出正确的段', () => {
  assert.deepEqual(splitBroker('mqtt://broker.example.com:11883'),
    { scheme: 'mqtt://', host: 'broker.example.com', port: 11883, path: '' });
  assert.deepEqual(splitBroker('mqtts://broker.example.com:8883'),
    { scheme: 'mqtts://', host: 'broker.example.com', port: 8883, path: '' });
  assert.deepEqual(splitBroker('wss://broker.example.com:443/ws'),
    { scheme: 'wss://', host: 'broker.example.com', port: 443, path: '/ws' });
});

/*
 * `mqtt:` 是**非特殊 scheme**，URL 解析器按 opaque path 处理 ——
 * `new URL('mqtt://h:1883').pathname` 是 `''` 而不是 `'/'`。
 * 这条把这个反直觉的行为钉住：别人照着 http 的直觉改这里会踩空。
 */
test('mqtt/mqtts 的 pathname 是空串，不是斜杠', () => {
  assert.equal(new URL('mqtt://h:1883').pathname, '');
  assert.equal(new URL('wss://h:443').pathname, '/');
  assert.equal(splitBroker('mqtt://h:1883').path, '');
  assert.equal(splitBroker('wss://h:443').path, '/mqtt', 'ws 系才会补默认 path');
});

/*
 * 从 mqtt 切到 ws 时 path 是空的，拼出来就是 `ws://host:8083` 没有路径。
 * 多数 broker 的 WebSocket 端点在 /mqtt 上，连过去 404 ——
 * 而界面上那格是空的，看不出少了什么。
 */
test('切到 ws/wss 且 path 为空时补默认路径，已有 path 不动', () => {
  assert.equal(pathOnSchemeChange('', 'wss://'), '/mqtt');
  assert.equal(pathOnSchemeChange('  ', 'ws://'), '/mqtt');
  assert.equal(pathOnSchemeChange('/custom', 'wss://'), '/custom', '用户填过的不能被改掉');
  assert.equal(pathOnSchemeChange('', 'mqtt://'), '', 'tcp 系没有 path 概念，不该补');
});

/*
 * 这条是防一类具体的错：地址没写端口时，要补的是**协议默认端口**，
 * 不是 ThingLinks 那组建议端口。`mqtts://host` 实际连 8883，
 * 补成 11884 就把地址悄悄改掉了，而界面上看起来「本来就该是这样」。
 */
test('没写端口时补协议默认端口，不是 ThingLinks 建议端口', () => {
  assert.equal(splitBroker('mqtt://host').port, 1883);
  assert.equal(splitBroker('mqtts://host').port, 8883);
  assert.notEqual(splitBroker('mqtts://host').port, 11884);
});

test('不认识的协议退回 mqtt://，而不是把它当成合法值', () => {
  assert.equal(splitBroker('http://host:80').scheme, 'mqtt://');
});

/*
 * 解析失败时**不清空**：把原值原样放进主机格，让人看得见那串东西再自己改。
 * 清空之后没人知道原来配的是什么 —— 那是比显示一串怪东西更糟的结果。
 */
test('解析不了时保留原值，不清空', () => {
  const r = splitBroker('这不是个地址');
  assert.equal(r.host, '这不是个地址');
  assert.equal(r.scheme, 'mqtt://');
});

test('IPv6 的方括号要保留 —— 拼回去时正好是要的形态', () => {
  const r = splitBroker('mqtt://[::1]:1883');
  assert.equal(r.host, '[::1]');
  assert.equal(joinBroker(r), 'mqtt://[::1]:1883');
});

test('端口一律显式拼出，不依赖 mqtt.js 的默认端口', () => {
  assert.equal(joinBroker({ scheme: 'mqtts://', host: 'h', port: 8883, path: '/mqtt' }),
    'mqtts://h:8883');
});

test('只有 ws/wss 带 path，tcp 那两个不带', () => {
  assert.equal(joinBroker({ scheme: 'mqtt://', host: 'h', port: 1883, path: '/mqtt' }), 'mqtt://h:1883');
  assert.equal(joinBroker({ scheme: 'wss://', host: 'h', port: 443, path: '/mqtt' }), 'wss://h:443/mqtt');
});

test('path 没有前导斜杠时补上', () => {
  assert.equal(joinBroker({ scheme: 'ws://', host: 'h', port: 80, path: 'mqtt' }), 'ws://h:80/mqtt');
  assert.equal(joinBroker({ scheme: 'ws://', host: 'h', port: 80, path: '  ' }), 'ws://h:80');
});

test('主机两侧空白被吃掉 —— 粘贴地址最容易带上它', () => {
  assert.equal(joinBroker({ scheme: 'mqtt://', host: '  h  ', port: 1883, path: '' }), 'mqtt://h:1883');
});

/** 拆完再拼必须回到原样，否则「只是打开看了一眼」就把配置改了 */
test('往返一致：拆完再拼回原地址', () => {
  for (const url of [
    'mqtt://broker.example.com:11883',
    'mqtts://broker.example.com:11884',
    'ws://10.0.0.5:8083/mqtt',
    'wss://broker.example.com:443/ws',
    'mqtt://[::1]:1883',
  ]) {
    assert.equal(joinBroker(splitBroker(url)), url, `往返不一致：${url}`);
  }
});

test('加密判定只看 scheme', () => {
  assert.equal(isSecure('mqtts://'), true);
  assert.equal(isSecure('wss://'), true);
  assert.equal(isSecure('mqtt://'), false);
  assert.equal(isSecure('ws://'), false);
  assert.equal(isWs('ws://'), true);
  assert.equal(isWs('mqtts://'), false);
});

/*
 * 换协议带端口，但只在用户没自己改过时带。
 * 用户填的自定义端口被静默改掉，是最难被发现的一类改动。
 */
test('换协议时：默认端口跟着走，自定义端口保持不动', () => {
  assert.equal(portOnSchemeChange(11883, 'mqtts://'), 11884, '默认端口应跟随协议');
  assert.equal(portOnSchemeChange(1884, 'mqtts://'), 1884, '用户自填的端口不能被改掉');
});

test('一键默认地址：加密与不加密各自给对端口', () => {
  assert.equal(defaultBroker(true).scheme, 'mqtts://');
  assert.equal(defaultBroker(false).scheme, 'mqtt://');
  assert.notEqual(defaultBroker(true).port, defaultBroker(false).port);
});
