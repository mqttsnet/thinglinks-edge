import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { probeEndpoint } from './probe.ts';

/** 起一个真的 TCP 服务端，返回它的端口 */
function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

/** 找一个几乎肯定没人监听的端口：先占住再立刻释放 */
async function closedPort(): Promise<number> {
  const { server, port } = await listen();
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/*
 * 这条不断言「不存在的主机探不通」——在这台机器上它**探得通**。
 *
 * 本机跑着 fake-IP 模式的代理：随手编的域名解析到 198.18.x.x，
 * 而且往那个地址发起的 TCP 连接**也会被代理当场接受**（代理先接下来，
 * 之后才发现上游不可达）。于是 DNS 与 TCP 两步全绿，主机却根本不存在。
 *
 * 这是探针能力的真实边界，不是 bug：透明代理与运营商劫持都会造成同样效果。
 * 所以这里只断言**内部一致性**（结论与两步结果对得上、失败必带原因），
 * 「所以 broker 一定是好的」这种推论由 cloud_link 的真实链路状态去否定，
 * 不由 TCP 探针背书。
 */
test('探测结论必须与两步结果自洽，且失败一定带原因', async () => {
  const r = await probeEndpoint('mqtt://this-host-does-not-exist.invalid:1883', 2_000);
  if (!r.dns.ok) {
    assert.equal(r.tcp, null, '解析没成功就不该有 TCP 结果');
    assert.match(r.summary, /解析失败/);
    assert.ok(r.dns.error);
    return;
  }
  assert.ok(r.tcp, '解析成功后必须有 TCP 结果');
  if (r.tcp.ok) {
    assert.match(r.summary, /可达/);
  } else {
    assert.match(r.summary, /不可达/);
    assert.ok(r.tcp.error, '不可达必须说明原因');
  }
});

test('probeEndpoint 分两步报：解析失败时不会再去连', async () => {
  const r = await probeEndpoint(`mqtt://${'a'.repeat(70)}.example:1883`);
  assert.equal(r.dns.ok, false);
  assert.equal(r.tcp, null, '解析都没成功就不该有 TCP 结果');
  assert.match(r.summary, /解析失败/);
});

test('probeEndpoint 连通时给出可读结论', async () => {
  const { server, port } = await listen();
  try {
    const r = await probeEndpoint(`127.0.0.1:${port}`);
    assert.equal(r.dns.ok, true);
    assert.equal(r.tcp?.ok, true);
    assert.match(r.summary, /可达/);
  } finally {
    server.close();
  }
});
