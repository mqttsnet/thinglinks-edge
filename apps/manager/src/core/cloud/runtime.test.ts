/**
 * CloudRuntime 的状态机测试。
 *
 * 这里**不验 MQTT 协议行为**（CONNECT 报文、QoS1、重连重订阅）——
 * 那些在 scripts/verify-cloud-gateway.mjs 里对着真 mosquitto 跑。
 * 用假客户端只为把「配置怎么变、连接状态怎么走」这条线单独钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CloudRuntime } from './runtime.ts';
import type { CloudConfig } from './config-repo.ts';

/** 最小可用的假 mqtt 客户端。连接时机由测试显式驱动，不靠 sleep */
class FakeClient extends EventEmitter {
  published: Array<{ topic: string; payload: string }> = [];
  ended = false;
  subscribed: string[] = [];

  subscribe(topics: string[]): void { this.subscribed.push(...topics); }
  async publishAsync(topic: string, payload: string): Promise<void> {
    if (this.ended) throw new Error('客户端已关闭');
    this.published.push({ topic, payload });
  }
  async endAsync(): Promise<void> { this.ended = true; }

  goOnline(): void { this.emit('connect'); }
  goOffline(): void { this.emit('close'); }
  fail(msg: string): void { this.emit('error', new Error(msg)); }
}

const config = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  enabled: true,
  brokerUrl: 'mqtt://127.0.0.1:1883',
  clientId: '2130020836696064@1',
  deviceIdentification: 'edge-gw-01',
  username: 'u',
  password: 'p',
  cipher: { cipherFlag: 0, signKey: 'sign-key-abc' },
  tls: {
    mode: 'system',
    ca: '',
    cert: '',
    key: '',
    rejectUnauthorized: true,
    servername: '',
  },
  protocolVersion: 'v1',
  qos: 1,
  updatedAt: '2026-08-27 00:00:00',
  updatedBy: 'admin',
  ...over,
});

/** 造一个 runtime，并把生成的假客户端交出来供测试驱动 */
function harness() {
  const clients: FakeClient[] = [];
  const states: string[] = [];
  const runtime = new CloudRuntime({
    connectFn: () => {
      const c = new FakeClient();
      clients.push(c);
      return c as never;
    },
    onStateChange: (s) => states.push(s),
  });
  return { runtime, clients, states, last: () => clients[clients.length - 1]! };
}

test('未配置时 state 是 unconfigured，publish 直接抛错', async () => {
  const { runtime } = harness();
  assert.equal(runtime.state, 'unconfigured');
  assert.equal(runtime.configured, false);
  await assert.rejects(() => runtime.publish({ a: 1 }), /云对接未配置/);
});

test('配置了但关闭时 state 是 disabled，不建立连接', async () => {
  const { runtime, clients } = harness();
  await runtime.apply(config({ enabled: false }));
  assert.equal(runtime.state, 'disabled');
  assert.equal(runtime.configured, false);
  assert.equal(clients.length, 0, '关闭状态不该去连 broker');
  await assert.rejects(() => runtime.publish({ a: 1 }), /云对接已关闭/);
});

test('启用后立刻建连，但 apply 不等它连上', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  // apply 已返回，此时还没 connect 事件
  assert.equal(runtime.state, 'connecting');
  assert.equal(runtime.configured, true);
  last().goOnline();
  assert.equal(runtime.state, 'online');
});

test('连上之前 publish 抛错 —— 数据要落 spool，不能进 mqtt 的内存队列', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  await assert.rejects(() => runtime.publish({ a: 1 }), /网关未连接/);
  assert.equal(last().published.length, 0);
  assert.equal(runtime.status().failed, 1);
});

test('连上后 publish 走到客户端，并计数', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  last().goOnline();
  await runtime.publish({ deviceId: 'd1' });

  assert.equal(last().published.length, 1);
  assert.equal(last().published[0]!.topic, '/v1/devices/edge-gw-01/datas');
  assert.equal(runtime.status().published, 1);
  assert.equal(runtime.status().failed, 0);
});

test('断线后 publish 重新抛错，恢复后又能发', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  last().goOnline();
  await runtime.publish({ a: 1 });

  last().goOffline();
  assert.equal(runtime.state, 'offline');
  await assert.rejects(() => runtime.publish({ a: 2 }), /网关未连接/);

  last().goOnline();
  await runtime.publish({ a: 3 });
  assert.equal(last().published.length, 2, '断线期间那条不该被发出');
});

test('重新 apply 会拆掉旧连接再建新的', async () => {
  const { runtime, clients } = harness();
  await runtime.apply(config());
  clients[0]!.goOnline();

  await runtime.apply(config({ brokerUrl: 'mqtt://10.0.0.9:1883' }));
  assert.equal(clients.length, 2, '应该建了新客户端');
  assert.equal(clients[0]!.ended, true, '旧客户端必须被关掉，否则两条连接同时在线');
  assert.equal(runtime.status().brokerUrl, 'mqtt://10.0.0.9:1883');
});

test('apply(undefined) 拆连接并回到未配置', async () => {
  const { runtime, clients } = harness();
  await runtime.apply(config());
  clients[0]!.goOnline();

  await runtime.apply(undefined);
  assert.equal(runtime.state, 'unconfigured');
  assert.equal(clients[0]!.ended, true);
});

test('连接报错只记 lastError，不拆连接 —— 客户端还在后台重试', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  last().fail('ECONNREFUSED');
  await runtime.waitSettled(50);

  const st = runtime.status();
  assert.match(st.lastError, /ECONNREFUSED/);
  assert.ok(st.lastErrorAt, 'lastErrorAt 应有时间戳');
  assert.equal(runtime.configured, true, '报错不该让 configured 变 false');
  assert.equal(last().ended, false, '不该因为一次连接失败就关掉客户端');
});

test('waitSettled 在连上后返回 online；超时不抛错只回当前状态', async () => {
  const { runtime, last } = harness();
  await runtime.apply(config());
  last().goOnline();
  assert.equal(await runtime.waitSettled(1_000), 'online');

  const h2 = harness();
  await h2.runtime.apply(config());
  assert.equal(await h2.runtime.waitSettled(30), 'connecting', '超时应返回当前状态而不是抛错');
});

test('status 不含口令等凭据', async () => {
  const { runtime } = harness();
  await runtime.apply(config({ password: 'super-secret-pass' }));
  assert.ok(!JSON.stringify(runtime.status()).includes('super-secret-pass'));
});

test('close 之后回到未配置且客户端已关', async () => {
  const { runtime, clients } = harness();
  await runtime.apply(config());
  clients[0]!.goOnline();
  await runtime.close();
  assert.equal(runtime.state, 'unconfigured');
  assert.equal(clients[0]!.ended, true);
});
