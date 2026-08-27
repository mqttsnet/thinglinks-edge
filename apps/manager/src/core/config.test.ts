import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  ConfigError,
  normalizeBasePath,
  adminRootFor,
  authTokenKeyFor,
} from './config.ts';

const base = (over: Record<string, string> = {}) => ({ EXTERNAL_URL: 'http://127.0.0.1:8080', ...over });

test('缺少 EXTERNAL_URL 时拒绝启动并说明为什么', () => {
  assert.throws(() => loadConfig({}), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.match((e as Error).message, /唯一真源/);
    return true;
  });
});

test('非法 URL 与非 http(s) 协议被拒绝', () => {
  assert.throws(() => loadConfig({ EXTERNAL_URL: 'not-a-url' }), ConfigError);
  assert.throws(() => loadConfig({ EXTERNAL_URL: 'ftp://host/x' }), ConfigError);
});

test('纯 IP 无域名可用，basePath 为空', () => {
  const c = loadConfig(base({ EXTERNAL_URL: 'http://192.168.10.20:8080' }));
  assert.equal(c.basePath, '');
  assert.equal(c.cookieSecure, false);
  assert.deepEqual(c.allowedOrigins, ['http://192.168.10.20:8080']);
});

test('外层反代挂子路径时派生出 basePath', () => {
  const c = loadConfig(base({ EXTERNAL_URL: 'https://portal.corp.com/nodered/' }));
  assert.equal(c.basePath, '/nodered');
  assert.equal(c.cookieSecure, true, 'Secure 由 EXTERNAL_URL 的 scheme 判定，不看当前连接');
});

test('默认只监听回环，不监听全部网卡', () => {
  assert.equal(loadConfig(base()).listenAddr, '127.0.0.1');
  assert.equal(loadConfig(base({ LISTEN_ADDR: '0.0.0.0' })).listenAddr, '0.0.0.0');
});

test('端口范围非法时拒绝', () => {
  assert.throws(() => loadConfig(base({ INSTANCE_PORT_MIN: '31000', INSTANCE_PORT_MAX: '30000' })), ConfigError);
  assert.throws(() => loadConfig(base({ LISTEN_PORT: '70000' })), ConfigError);
  assert.throws(() => loadConfig(base({ LISTEN_PORT: 'abc' })), ConfigError);
});

test('normalizeBasePath 归一各种写法', () => {
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/nodered'), '/nodered');
  assert.equal(normalizeBasePath('/nodered/'), '/nodered');
  assert.equal(normalizeBasePath('/a/b///'), '/a/b');
});

test('adminRoot 必须带 basePath —— 丢前缀会让编辑器资源与 WebSocket 失效', () => {
  assert.equal(adminRootFor('', 'line-a'), '/red/line-a/');
  assert.equal(adminRootFor('/nodered', 'line-a'), '/nodered/red/line-a/');
});

test('token 存储键按 httpAdminRoot 命名空间化（实测 Node-RED 5.0.4）', () => {
  assert.equal(authTokenKeyFor('/red/line-a/'), 'auth-tokens-red-line-a');
  assert.equal(authTokenKeyFor('/nodered/red/line-a/'), 'auth-tokens-nodered-red-line-a');
  assert.equal(authTokenKeyFor('/'), 'auth-tokens', '挂根路径时退化为无后缀');
});
