import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { CloudGateway } from './gateway.ts';
import { DEFAULT_CONNECTION } from './connection.ts';
import { buildEnvelope, parseEnvelopeFull, serializeEnvelope } from './envelope.ts';

interface Packet {
  cmd: string;
  topic?: string;
  payload?: Buffer;
  messageId?: number;
  qos?: number;
  subscriptions?: { topic: string; qos: number }[];
}
// Use the parser bundled with our real mqtt.js dependency, without another broker dependency.
const mqttRequire = createRequire(createRequire(import.meta.url).resolve('mqtt/package.json'));
const packets = mqttRequire('mqtt-packet') as {
  parser(options: { protocolVersion: number }): EventEmitter & { parse(data: Buffer): void };
  generate(packet: Record<string, unknown>, options: { protocolVersion: number }): Buffer;
};
const protocol = { protocolVersion: 4 };
const cipher = { cipherFlag: 0 as const, signKey: 'presence-transport-test-key' };
type Publish = { packet: Packet; socket: Socket; connection: number };

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('local MQTT fixture did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(onPublish: (publish: Publish) => void, requestTimeoutMs = 1_000) {
  const sockets = new Set<Socket>();
  const received: Publish[] = [];
  let connections = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    const connection = ++connections;
    const parser = packets.parser(protocol);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => parser.parse(data));
    parser.on('error', () => socket.destroy());
    parser.on('packet', (packet: Packet) => {
      if (packet.cmd === 'connect') {
        socket.write(packets.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }, protocol));
      } else if (packet.cmd === 'subscribe') {
        socket.write(packets.generate({ cmd: 'suback', messageId: packet.messageId,
          granted: packet.subscriptions!.map(() => 1) }, protocol));
      } else if (packet.cmd === 'publish') {
        const publish = { packet, socket, connection };
        received.push(publish);
        onPublish(publish);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = new CloudGateway({
    brokerUrl: `mqtt://127.0.0.1:${address.port}`,
    credentials: { clientId: 'presence-transport-test', deviceIdentification: 'g', username: 'test', password: 'test' },
    cipher,
    connection: { ...DEFAULT_CONNECTION, mqttVersion: 4 },
    requestTimeoutMs,
    reconnectPeriodMs: requestTimeoutMs + 50,
  });
  try { await gateway.connect(); }
  catch (error) { for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  return {
    gateway, received, connections: () => connections,
    close: async () => {
      await gateway.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function acknowledge({ packet, socket }: Publish): void {
  if (packet.qos === 1) socket.write(packets.generate({ cmd: 'puback', messageId: packet.messageId }, protocol));
}

function respond(publish: Publish, body: unknown): void {
  const { head } = parseEnvelopeFull(publish.packet.payload!, cipher);
  publish.socket.write(packets.generate({ cmd: 'publish', topic: `${publish.packet.topic}Response`, qos: 0,
    payload: serializeEnvelope(buildEnvelope(body, cipher, { mid: head.mid })) }, protocol));
}

test('an expired ONLINE is never replayed by mqtt.js after reconnect', { timeout: 5_000 }, async () => {
  const f = await fixture(publish => {
    if (publish.packet.topic?.endsWith('/topo/update') && publish.connection === 1) {
      // A QoS 1 implementation retains this unacknowledged ONLINE in mqtt.js outgoingStore.
      publish.socket.destroy();
    } else {
      acknowledge(publish);
      if (publish.packet.topic?.endsWith('/topo/query')) respond(publish, { statusCode: 0, data: [] });
    }
  });
  try {
    await assert.rejects(f.gateway.updateSubDeviceStatus([{ deviceId: 'd', status: 'ONLINE' }]));
    await waitFor(() => f.connections() >= 2 && f.gateway.state === 'online');
    // This round trip is a barrier after mqtt.js has drained its reconnect store.
    await f.gateway.querySubDevices(['d']);
    const updates = f.received.filter(item => item.packet.topic?.endsWith('/topo/update'));
    assert.equal(updates.length, 1, 'a timed-out ONLINE must not be published on the new connection');
    assert.equal(updates[0]!.packet.qos, 0);
    assert.equal(f.received.find(item => item.packet.topic?.endsWith('/topo/query'))!.packet.qos, 0);
  } finally { await f.close(); }
});

test('MQTT publish completion alone never confirms a topology operation', { timeout: 5_000 }, async () => {
  const f = await fixture(acknowledge, 100);
  try {
    await assert.rejects(f.gateway.updateSubDeviceStatus([{ deviceId: 'd', status: 'ONLINE' }]), /超时/);
    assert.equal(f.received.length, 1);
  } finally { await f.close(); }
});

test('the signed matching business response resolves the status request and data keeps its QoS', { timeout: 5_000 }, async () => {
  const result = { statusCode: 0, data: [{ deviceId: 'd', statusCode: 0 }] };
  const f = await fixture(publish => {
    acknowledge(publish);
    if (publish.packet.topic?.endsWith('/topo/update')) respond(publish, result);
  });
  try {
    assert.deepEqual(await f.gateway.updateSubDeviceStatus([{ deviceId: 'd', status: 'OFFLINE' }]), result);
    await f.gateway.publishData({ devices: [] });
    assert.equal(f.received.find(item => item.packet.topic?.endsWith('/datas'))!.packet.qos, 1);
  } finally { await f.close(); }
});

test('cancellation before publish sends no state change', { timeout: 5_000 }, async () => {
  const f = await fixture(publish => {
    acknowledge(publish);
    respond(publish, { statusCode: 0, data: [] });
  });
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.gateway.updateSubDeviceStatus([{ deviceId: 'd', status: 'ONLINE' }], controller.signal), /取消/);
    await f.gateway.querySubDevices(['d']);
    assert.equal(f.received.filter(item => item.packet.topic?.endsWith('/topo/update')).length, 0);
  } finally { await f.close(); }
});

test('cancelling a sent request rejects it and its late reply cannot settle a new request', { timeout: 5_000 }, async () => {
  const f = await fixture(acknowledge);
  try {
    const controller = new AbortController();
    const cancelled = assert.rejects(
      f.gateway.updateSubDeviceStatus([{ deviceId: 'd', status: 'ONLINE' }], controller.signal), /取消/);
    await waitFor(() => f.received.length === 1);
    controller.abort(); await cancelled;
    let settled = false;
    const next = f.gateway.querySubDevices(['d']).then(value => { settled = true; return value; });
    await waitFor(() => f.received.length === 2);
    respond(f.received[0]!, { statusCode: 0, data: [{ deviceId: 'd', statusCode: 0 }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    const result = { statusCode: 0, data: [{ deviceId: 'd', statusCode: 0, deviceInfo: { nodeType: 2, gatewayId: 'g' } }] };
    respond(f.received[1]!, result);
    assert.deepEqual(await next, result);
  } finally { await f.close(); }
});
