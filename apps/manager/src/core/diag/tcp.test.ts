import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { tcpProbe } from './tcp.ts';

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

test('TCP 探针能连上真实监听端口，并给出握手耗时', async () => {
  const { server, port } = await listen();
  try {
    const r = await tcpProbe('127.0.0.1', port);
    assert.equal(r.ok, true, r.error ?? '');
    assert.ok(r.remoteAddress, 'remoteAddress 必须在 destroy 之前读出来');
    assert.ok(r.elapsedMs >= 0);
  } finally {
    server.close();
  }
});

test('端口没人监听时报连接被拒，且带原因', async () => {
  const port = await closedPort();
  const r = await tcpProbe('127.0.0.1', port, 2_000);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /ECONNREFUSED|超时/);
});

test('探针不在对端留下连接 —— 连完立刻销毁', async () => {
  const { server, port } = await listen();
  let stillOpen = 0;
  server.on('connection', (s) => {
    stillOpen += 1;
    s.on('close', () => { stillOpen -= 1; });
  });
  try {
    await tcpProbe('127.0.0.1', port);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stillOpen, 0, '探针连接必须已关闭，不能把对端的连接数吃掉');
  } finally {
    server.close();
  }
});
