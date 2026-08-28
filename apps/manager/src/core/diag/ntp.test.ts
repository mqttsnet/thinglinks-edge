import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { createSocket } from 'node:dgram';
import { sntpQuery, readClock } from './ntp.ts';

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

test('SNTP 能算出时钟偏差 —— 对着一个真的 UDP 服务端', async () => {
  const NTP_EPOCH = 2_208_988_800;
  // 假 NTP 服务端：故意把自己的时间报成「比本机快 5 秒」
  const SKEW_MS = 5_000;
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
  const port = socket.address().port;

  socket.on('message', (msg, rinfo) => {
    const reply = Buffer.alloc(48);
    reply[0] = 0x1c;                       // LI=0 VN=3 Mode=4(server)
    // originate：原样抄回客户端的 transmit（字节 40-47 → 24-31）
    msg.copy(reply, 24, 40, 48);
    const now = Date.now() + SKEW_MS;
    const sec = Math.floor(now / 1000) + NTP_EPOCH;
    const frac = Math.floor(((now % 1000) / 1000) * 2 ** 32);
    reply.writeUInt32BE(sec, 32); reply.writeUInt32BE(frac, 36);   // receive
    reply.writeUInt32BE(sec, 40); reply.writeUInt32BE(frac, 44);   // transmit
    socket.send(reply, rinfo.port, rinfo.address);
  });

  try {
    const r = await sntpQuery('127.0.0.1', 3_000, port);
    assert.equal(r.ok, true, r.error ?? '');
    assert.ok(
      Math.abs((r.offsetMs ?? 0) - SKEW_MS) < 500,
      `偏差应约等于 ${SKEW_MS}ms，实际 ${r.offsetMs}ms`,
    );
  } finally {
    socket.close();
  }
});

test('SNTP 问一个不存在的服务端时超时报错，不吊死', async () => {
  const r = await sntpQuery('127.0.0.1', 300, await closedPort());
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('没配时钟源时如实说明没检查，不编一个「正常」', async () => {
  const c = await readClock('');
  assert.equal(c.ok, true);
  assert.equal(c.offsetMs, undefined, '没查就不该有偏差读数');
  assert.match(c.note, /未配置时钟源/);
  assert.ok(c.timezone, '时区必须报出来——现场差 8 小时的问题全靠它');
  assert.ok(c.uptimeSec >= 0);
});

test('对时失败时 ok 为 false，且说清是哪台服务器', async () => {
  const c = await readClock(`127.0.0.1`, 300);
  assert.equal(c.ok, false);
  assert.match(c.note, /对时失败/);
  assert.equal(c.server, '127.0.0.1');
});
