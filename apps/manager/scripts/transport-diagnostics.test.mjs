import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probeFreshHttpStatus, transportDiagnostics } from './_transport-diagnostics.mjs';

test('transport diagnostics retains socket error code and elapsed time without request secrets', () => {
  const cause = Object.assign(new Error('cookie=session-secret'), {
    code: 'UND_ERR_SOCKET', socket: { bytesRead: 100, bytesWritten: 200 },
  });
  const error = new TypeError('fetch failed: password=secret-password', { cause });
  const result = transportDiagnostics(error, 125);
  assert.equal(result.elapsedMs, 125);
  assert.equal(result.errors[1].code, 'UND_ERR_SOCKET');
  assert.deepEqual(result.socket, { bytesRead: 100, bytesWritten: 200 });
  assert.doesNotMatch(JSON.stringify(result), /cookie|password|secret/);
});

test('transport diagnostics bounds cyclic causes and retains aggregate connection codes', () => {
  const error = new AggregateError([
    Object.assign(new Error(), { code: 'ECONNREFUSED' }),
    Object.assign(new Error(), { code: 'ETIMEDOUT' }),
  ]);
  error.cause = error;
  assert.deepEqual(transportDiagnostics(error, 10).connectionCodes, ['ECONNREFUSED', 'ETIMEDOUT']);
});

test('health diagnostics opens a new socket for each probe and consumes the response', async (t) => {
  const sockets = new Set();
  const server = createServer((request, response) => {
    sockets.add(request.socket);
    response.writeHead(200);
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  assert.equal(await probeFreshHttpStatus(url), 200);
  assert.equal(await probeFreshHttpStatus(url), 200);
  assert.equal(sockets.size, 2);
});

test('health diagnostics has an absolute deadline even while a response keeps streaming', async (t) => {
  const server = createServer((request, response) => {
    const interval = setInterval(() => response.write('still waiting'), 5);
    request.on('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let rescued = false;
  const rescue = setTimeout(() => { rescued = true; server.closeAllConnections(); }, 500);
  t.after(() => clearTimeout(rescue));
  assert.equal(await probeFreshHttpStatus(`http://127.0.0.1:${server.address().port}/healthz`, 25), 0);
  assert.equal(rescued, false, 'diagnostic must finish before the rescue closes the socket');
});
