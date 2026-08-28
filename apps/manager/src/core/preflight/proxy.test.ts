import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { checkProxy } from './proxy.ts';

/**
 * 一个**非回环**的本机地址。
 *
 * 「代理可达就该 pass」这条只能用非回环地址验：回环地址本身会触发告警
 * （容器里的 127.0.0.1 指向容器自己），拿它验 pass 是自相矛盾的。
 * 完全隔离的环境（无网卡）拿不到，那种情况下跳过这一条。
 */
const lanIp = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const internal = { managerContainer: 'tle-manager', instancePrefix: 'tle-nr-', network: 'tle-net' };
const none = { httpProxy: '', httpsProxy: '', noProxy: '' };

test('没配代理时跳过，并说明离线部署本就该是这样', async () => {
  const r = await checkProxy({ proxy: none, internal, cloudConfigured: false });
  assert.equal(r.status, 'skip');
  assert.match(r.detail, /离线部署/);
});

test('代理地址不合法直接阻断安装', async () => {
  const r = await checkProxy({
    proxy: { httpProxy: 'proxy.corp:8080', httpsProxy: '', noProxy: '' },
    internal, cloudConfigured: false,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'block');
});

test('代理不通要阻断 —— 否则现场表现是所有对外请求一路卡到超时', async () => {
  const r = await checkProxy({
    // 9 号端口（discard）在多数机器上没人监听，用它模拟不通
    proxy: { httpProxy: 'http://127.0.0.1:9', httpsProxy: '', noProxy: '' },
    internal, cloudConfigured: false, timeoutMs: 1500,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'block');
});

test('代理可达且 NO_PROXY 齐全时通过', { skip: lanIp ? false : '本机没有非回环地址' }, async () => {
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, '0.0.0.0', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await checkProxy({
      proxy: {
        httpProxy: `http://${lanIp}:${port}`, httpsProxy: '',
        noProxy: 'localhost,tle-manager,tle-nr-,tle-net',
      },
      internal, cloudConfigured: false, timeoutMs: 1500,
    });
    assert.equal(r.status, 'pass', r.detail);
  } finally { srv.close(); }
});

test('NO_PROXY 漏内部条目要告警，且点明后果', async () => {
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await checkProxy({
      proxy: { httpProxy: `http://127.0.0.1:${port}`, httpsProxy: '', noProxy: '' },
      internal, cloudConfigured: false, timeoutMs: 1500,
    });
    assert.equal(r.status, 'fail');
    assert.equal(r.severity, 'warn', '能装但会踩坑，不该阻断');
    assert.match(r.detail, /tle-manager/);
  } finally { srv.close(); }
});

test('配了云连接就要说清 MQTT 不走 HTTP 代理', async () => {
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await checkProxy({
      proxy: {
        httpProxy: `http://127.0.0.1:${port}`, httpsProxy: '',
        noProxy: 'localhost,tle-manager,tle-nr-,tle-net',
      },
      internal, cloudConfigured: true, timeoutMs: 1500,
    });
    assert.match(r.detail, /MQTT/);
  } finally { srv.close(); }
});

test('回环地址的代理要提醒 —— 容器里的 127.0.0.1 是容器自己', async () => {
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await checkProxy({
      proxy: {
        httpProxy: `http://127.0.0.1:${port}`, httpsProxy: '',
        noProxy: 'localhost,tle-manager,tle-nr-,tle-net',
      },
      internal, cloudConfigured: false, timeoutMs: 1500,
    });
    assert.equal(r.data?.['loopbackProxy'], true);
    assert.match(r.detail, /容器里的回环/);
  } finally { srv.close(); }
});

test('代理地址里带口令要提醒 —— 它会落进实例容器与进程列表', async () => {
  const srv = createServer(() => {});
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await checkProxy({
      proxy: {
        httpProxy: `http://u:pw@127.0.0.1:${port}`, httpsProxy: '',
        noProxy: 'localhost,tle-manager,tle-nr-,tle-net',
      },
      internal, cloudConfigured: false, timeoutMs: 1500,
    });
    assert.equal(r.data?.['credentialsInUrl'], true);
    assert.match(r.detail, /口令/);
  } finally { srv.close(); }
});
