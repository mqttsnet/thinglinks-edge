import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readProxySettings, proxyConfigured, buildNoProxy, proxyEnvFor,
  parseProxyUrl, proxyHasCredentials, missingInternalNoProxy,
} from './proxy.ts';

const hosts = {
  managerContainer: 'thinglinks-edge-manager',
  instancePrefix: 'tle-nr-',
  network: 'thinglinks-edge',
};

test('大小写两种写法都认 —— 现场两种都会出现', () => {
  assert.equal(readProxySettings({ HTTP_PROXY: 'http://p:8080' }).httpProxy, 'http://p:8080');
  assert.equal(readProxySettings({ http_proxy: 'http://p:8080' }).httpProxy, 'http://p:8080');
  assert.equal(readProxySettings({}).httpProxy, '');
});

test('没配代理时一切退化为不做事（离线部署是常态）', () => {
  const p = readProxySettings({});
  assert.equal(proxyConfigured(p), false);
  assert.deepEqual(proxyEnvFor(p, hosts), []);
});

test('NO_PROXY 必须补上内部条目，否则容器间通信会被绕去代理', () => {
  const v = buildNoProxy('', hosts).split(',');
  assert.ok(v.includes('localhost') && v.includes('127.0.0.1'));
  assert.ok(v.includes('thinglinks-edge-manager'), '漏了 Manager 容器名，实例回报会走代理');
  assert.ok(v.includes('tle-nr-'), '漏了实例名前缀，反代会走代理');
  assert.ok(v.includes('thinglinks-edge'), '漏了网络名');
});

test('用户填的条目原样保留且排在前面 —— 企业网管的清单不能被改写', () => {
  const v = buildNoProxy('10.0.0.0/8, .corp.com', hosts);
  assert.ok(v.startsWith('10.0.0.0/8,.corp.com,'), v);
});

test('重复条目不叠加', () => {
  const v = buildNoProxy('localhost,127.0.0.1', hosts).split(',');
  assert.equal(v.filter((x) => x === 'localhost').length, 1);
});

test('注入容器的变量大小写各给一份 —— 容器里的程序读哪种全看实现', () => {
  const env = proxyEnvFor({ httpProxy: 'http://p:8080', httpsProxy: '', noProxy: '' }, hosts);
  assert.ok(env.includes('HTTP_PROXY=http://p:8080'));
  assert.ok(env.includes('http_proxy=http://p:8080'));
  assert.ok(env.some((e) => e.startsWith('NO_PROXY=')));
  // 只配了 HTTP_PROXY 时，HTTPS 也回落到它 —— 否则 https 出网会绕过代理直连并超时
  assert.ok(env.includes('HTTPS_PROXY=http://p:8080'));
});

test('不注入空值 —— `HTTP_PROXY=` 会被部分客户端当成配了一个空代理', () => {
  const env = proxyEnvFor({ httpProxy: '', httpsProxy: '', noProxy: 'x' }, hosts);
  assert.deepEqual(env, []);
});

test('代理地址形态校验', () => {
  assert.equal(parseProxyUrl('http://proxy.corp.com:8080').ok, true);
  assert.equal(parseProxyUrl('proxy.corp.com:8080').ok, false, '缺协议应判非法');
  assert.equal(parseProxyUrl('socks5://p:1080').ok, false, 'HTTP 代理不支持 socks');
  const r = parseProxyUrl('http://proxy.corp.com');
  assert.equal(r.ok && r.port, 80, '缺端口按协议默认');
});

test('认出内嵌账号口令的代理地址 —— 它会随环境变量落进容器', () => {
  assert.equal(proxyHasCredentials('http://user:pw@proxy:8080'), true);
  assert.equal(proxyHasCredentials('http://proxy:8080'), false);
});

test('Manager 自己的 NO_PROXY 漏了内部条目要能查出来', () => {
  const p = { httpProxy: 'http://c:8080', httpsProxy: '', noProxy: 'localhost' };
  const missing = missingInternalNoProxy(p, hosts);
  // 漏了 docker 代理与实例前缀 —— 这正是「创建实例失败：无法查询镜像」那个故障
  assert.ok(missing.includes('thinglinks-edge-manager'));
  assert.ok(missing.includes('tle-nr-'));
});

test('NO_PROXY 齐全时不报警；没配代理时更不该报', () => {
  const full = 'localhost,thinglinks-edge-manager,tle-nr-,thinglinks-edge';
  assert.deepEqual(missingInternalNoProxy({ httpProxy: 'http://c:8080', httpsProxy: '', noProxy: full }, hosts), []);
  assert.deepEqual(missingInternalNoProxy({ httpProxy: '', httpsProxy: '', noProxy: '' }, hosts), []);
});
