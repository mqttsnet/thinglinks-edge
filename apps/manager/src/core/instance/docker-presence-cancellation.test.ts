import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DockerClient } from './docker-client.ts';

test('presence list cancellation reaches the installed Dockerode/modem HTTP socket', async () => {
  let received!: () => void; let closed!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer((request, _response) => {
    assert.ok(request.url?.startsWith('/containers/json?'));
    request.once('close', closed); received();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const docker = new DockerClient({ connection: { host: '127.0.0.1', port: address.port, protocol: 'http' }, network: 'test', imageRepo: 'test', portRange: { min: 30000, max: 30001 }, instanceDataRoot: '/tmp/test-presence-unused', timezone: 'UTC' });
  const abort = new AbortController();
  try {
    const pending = docker.list(abort.signal); await arrived;
    abort.abort(); await assert.rejects(pending, /abort/i); await disconnected;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
