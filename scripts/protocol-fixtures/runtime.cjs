/* global Buffer, console, process, URL */
/** Local simulated devices and an ingest recorder. Only launched in the verifier-owned container. */
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { createRequire } = require('node:module');
const reports = [];
const deviceState = { modbus: 250, s7: 25, opcua: 25, http: 25, tcp: 25, udp: 25 };
const writes = { modbus: 0, s7: 0, opcua: 0, http: 0, tcp: 0, udp: 0 };
const paused = new Set();
const fixtureRun = process.env.PROTOCOL_FIXTURE_RUN;
if (!/^[a-f0-9-]{36}$/.test(fixtureRun ?? '')) throw new Error('fixture run identity required');

function framedServer(port, sizeOf, respond) {
  return net
    .createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (bytes) => {
        pending = Buffer.concat([pending, bytes]);
        if (pending.length > 65536) return socket.destroy();
        while (pending.length >= 7) {
          const length = sizeOf(pending);
          if (length < 7 || length > 65536) return socket.destroy();
          if (pending.length < length) break;
          const frame = pending.subarray(0, length);
          pending = pending.subarray(length);
          const reply = respond(frame);
          if (reply) socket.write(reply);
        }
      });
    })
    .listen(port, '127.0.0.1');
}

// Modbus TCP FC3/FC4; registers 0 and 1 hold 250 and 65.
framedServer(
  15020,
  (b) => b.readUInt16BE(4) + 6,
  (request) => {
    if (paused.has('modbus')) return null;
    const count = request.readUInt16BE(10);
    if (request[7] === 6) {
      deviceState.modbus = request.readUInt16BE(10);
      writes.modbus++;
      return Buffer.from(request);
    }
    if (request[7] === 16) {
      deviceState.modbus = request.readUInt16BE(13);
      writes.modbus++;
      const r = Buffer.from(request.subarray(0, 12));
      r.writeUInt16BE(6, 4);
      return r;
    }
    if (![3, 4].includes(request[7]) || count > 125) {
      const error = Buffer.from(request.subarray(0, 9));
      error.writeUInt16BE(3, 4);
      error[7] |= 0x80;
      error[8] = 1;
      return error;
    }
    const reply = Buffer.alloc(9 + count * 2);
    request.copy(reply, 0, 0, 8);
    reply.writeUInt16BE(count * 2 + 3, 4);
    reply[8] = count * 2;
    for (let i = 0; i < count; i++) reply.writeUInt16BE(i === 0 ? deviceState.modbus : 65, 9 + i * 2);
    return reply;
  },
);

// Minimal S7 fixture: COTP, setup communication and ReadVar/WriteVar of a 64-byte DB.
const memory = Buffer.alloc(64);
memory.writeFloatBE(25, 0);
memory.writeInt16BE(65, 4);
framedServer(
  15030,
  (b) => b.readUInt16BE(2),
  (request) => {
    if (request[5] === 0xe0) {
      const reply = Buffer.from(request);
      reply[5] = 0xd0;
      request.copy(reply, 6, 8, 10);
      reply.writeUInt16BE(1, 8);
      return reply;
    }
    const parameters = request.subarray(17, 17 + request.readUInt16BE(13));
    let param,
      data = Buffer.alloc(0);
    if (parameters[0] === 0xf0) param = Buffer.from(parameters);
    else if (parameters[0] === 4) {
      param = Buffer.from([4, parameters[1]]);
      const values = [];
      for (let i = 0; i < parameters[1]; i++) {
        const item = 2 + i * 12;
        const count = parameters.readUInt16BE(item + 4);
        const address = parameters.readUIntBE(item + 9, 3) / 8;
        const value = Buffer.alloc(4 + count + (count % 2 && i < parameters[1] - 1 ? 1 : 0));
        value[0] = 0xff;
        value[1] = 4;
        value.writeUInt16BE(count * 8, 2);
        memory.copy(value, 4, address, address + count);
        values.push(value);
      }
      data = Buffer.concat(values);
    } else if (parameters[0] === 5) {
      param = Buffer.from([5, parameters[1]]);
      const start = 17 + request.readUInt16BE(13);
      const count = request.readUInt16BE(start + 2) / 8;
      const address = parameters.readUIntBE(11, 3) / 8;
      request.copy(memory, address, start + 4, start + 4 + count);
      deviceState.s7 = memory.readFloatBE(0);
      writes.s7++;
      data = Buffer.from([0xff]);
    } else throw new Error('Unsupported S7 fixture function');
    const reply = Buffer.alloc(19 + param.length + data.length);
    Buffer.from([3, 0, 0, 0, 2, 0xf0, 0x80, 0x32, 3, 0, 0]).copy(reply);
    reply.writeUInt16BE(reply.length, 2);
    request.copy(reply, 11, 11, 13);
    reply.writeUInt16BE(param.length, 13);
    reply.writeUInt16BE(data.length, 15);
    param.copy(reply, 19);
    data.copy(reply, 19 + param.length);
    return reply;
  },
);

async function main() {
  const cloud =
    process.env.PROTOCOL_COMMAND_TEST === '1'
      ? (await import('/data/cloud-bridge.mjs')).createCloudBridge()
      : null;
  const commandCloud = cloud ? await cloud : null;
  net
    .createServer((socket) => {
      let text = '';
      socket.on('error', () => {});
      socket.on('data', (bytes) => {
        text += bytes;
        const end = text.indexOf('\n');
        if (end < 0) return;
        try {
          const body = JSON.parse(text.slice(0, end));
          deviceState.tcp = body.params.temperature;
          writes.tcp++;
          socket.write(JSON.stringify({ requestId: body.requestId, ok: true }) + '\n');
          text = '';
        } catch {
          socket.destroy();
        }
      });
    })
    .listen(15011, '127.0.0.1');
  const udp = dgram.createSocket('udp4');
  udp.on('message', (bytes, remote) => {
    try {
      const body = JSON.parse(bytes);
      deviceState.udp = body.params.temperature;
      writes.udp++;
      udp.send(
        Buffer.from(JSON.stringify({ requestId: body.requestId, ok: true })),
        remote.port,
        remote.address,
      );
    } catch {
      /* test malformed packet */
    }
  });
  udp.bind(15012, '127.0.0.1');
  const requireOpc = createRequire('/data/node_modules/node-red-contrib-opcua/package.json');
  const { OPCUAServer, OPCUACertificateManager, Variant, DataType } = requireOpc('node-opcua');
  async function startOpc() {
    const opc = new OPCUAServer({
      port: 15040,
      resourcePath: '/UA/Fixture',
      hostname: '127.0.0.1',
      serverCertificateManager: new OPCUACertificateManager({ rootFolder: '/tmp/protocol-opc-certificates' }),
      userCertificateManager: new OPCUACertificateManager({
        rootFolder: '/tmp/protocol-opc-user-certificates',
      }),
      buildInfo: { productName: 'ProtocolFixture', buildNumber: '1', buildDate: new Date('2026-01-01') },
    });
    await opc.initialize();
    const namespace = opc.engine.addressSpace.getOwnNamespace();
    namespace.addVariable({
      organizedBy: opc.engine.addressSpace.rootFolder.objects,
      browseName: 'Temperature',
      nodeId: 'ns=1;s=Temperature',
      dataType: 'Double',
      value: {
        get: () => new Variant({ dataType: DataType.Double, value: deviceState.opcua }),
        set: (value) => {
          deviceState.opcua = value.value;
          writes.opcua++;
          return requireOpc('node-opcua').StatusCodes.Good;
        },
      },
    });
    await opc.start();
    return opc;
  }
  let opc = await startOpc();
  http
    .createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        let text = '';
        for await (const bytes of request) {
          text += bytes;
          if (text.length > 1048576) throw new Error('body limit');
        }
        const body = text ? JSON.parse(text) : {};
        response.setHeader('content-type', 'application/json');
        if (url.pathname === '/availability') {
          if (body.protocol === 'opcua') {
            if (body.available === false && opc) {
              await opc.shutdown(0);
              opc = null;
            } else if (body.available === true && !opc) opc = await startOpc();
          } else if (body.protocol === 'modbus') {
            if (body.available === false) paused.add('modbus');
            else paused.delete('modbus');
          } else throw new Error('Unknown availability fixture');
          return response.end('{}');
        }
        if (url.pathname === '/healthz')
          return response.end(JSON.stringify({ ready: true, run: fixtureRun }));
        if (url.pathname === '/device-data')
          return response.end(JSON.stringify({ temperature: deviceState.http, humidity: 65 }));
        if (url.pathname === '/device-control') {
          deviceState.http = body.temperature;
          writes.http++;
          return response.end('{"ok":true}');
        }
        if (url.pathname === '/state') return response.end(JSON.stringify({ deviceState, writes }));
        if (commandCloud && url.pathname === '/issue')
          return response.end(JSON.stringify(await commandCloud.issue(body)));
        if (commandCloud && url.pathname === '/receipts')
          return response.end(JSON.stringify(commandCloud.receipts));
        if (commandCloud && url.pathname === '/commands')
          return response.end(JSON.stringify(commandCloud.bridge.list()));
        if (commandCloud && url.pathname === '/bindings')
          return response.end(JSON.stringify(commandCloud.bindings()));
        if (url.pathname === '/reports') return response.end(JSON.stringify(reports));
        if (url.pathname === '/reset') {
          reports.length = 0;
          return response.end('{}');
        }
        if (url.pathname.startsWith('/api/edge/')) {
          if (request.headers.authorization !== 'Bearer protocol-fixture-only') {
            response.writeHead(401);
            return response.end('{}');
          }
          if (commandCloud && url.pathname === '/api/edge/command-bindings')
            return response.end(
              JSON.stringify(commandCloud.bridge.registerBindings('protocol-fixture', body)),
            );
          if (commandCloud && url.pathname === '/api/edge/commands/next')
            return response.end(
              JSON.stringify({ command: commandCloud.bridge.next('protocol-fixture', body) }),
            );
          const match = /^\/api\/edge\/commands\/([^/]+)\/result$/.exec(url.pathname);
          if (commandCloud && match)
            return response.end(
              JSON.stringify({
                command: await commandCloud.bridge.complete('protocol-fixture', match[1], body),
              }),
            );
          if (url.pathname === '/api/edge/uplink')
            reports.push({ ...body, fixtureRun, receivedAt: Date.now() });
          response.writeHead(202);
          return response.end('{"accepted":1,"cloud":"queued"}');
        }
        if (url.pathname === '/trigger/tcp') {
          await new Promise((resolve, reject) => {
            const socket = net.connect({ host: '127.0.0.1', port: body.port }, () =>
              socket.end(body.payload),
            );
            socket.on('error', reject);
            socket.on('close', resolve);
          });
          return response.end('{}');
        }
        if (url.pathname === '/trigger/udp') {
          await new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            socket.on('error', reject);
            socket.send(Buffer.from(body.payload), body.port, '127.0.0.1', (error) => {
              socket.close();
              error ? reject(error) : resolve();
            });
          });
          return response.end('{}');
        }
        response.writeHead(404);
        response.end('{}');
      } catch (error) {
        response.writeHead(Number.isInteger(error.status) ? error.status : 500);
        response.end(JSON.stringify({ error: error.message }));
      }
    })
    .listen(19101, '127.0.0.1', () => console.log('PROTOCOL_FIXTURES_READY'));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
