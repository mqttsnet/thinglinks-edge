import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { constants as osConstants } from 'node:os';
import { runInNewContext } from 'node:vm';
import { NETWORK_BOOTSTRAP_SOURCE, networkBootstrapEntrypoint } from './network-bootstrap.ts';

function fixture(responses: unknown[]) {
  const networkId = 'a'.repeat(64), events: string[] = [], child = new EventEmitter() as EventEmitter & { kill(signal: string): void };
  const process = new EventEmitter() as EventEmitter & { env: Record<string, string>; exit(code: number): never };
  process.env = { TLE_NETWORK_GUARD_ID: networkId, TLE_NETWORK_GUARD_GATEWAY: '172.30.0.1', TLE_NETWORK_GUARD_PORT: '31555' };
  process.exit = (code: number) => { events.push(`exit:${code}`); return undefined as never; };
  child.kill = signal => { events.push(`signal:${signal}`); };
  const calls: Array<{ path: string; hostname: string; port: number }> = [];
  let clock = 0;
  let nextTimer = 0;
  const timers = new Set<number>();
  const loaded = new EventEmitter();
  const http = {
    get(options: { path: string; hostname: string; port: number }, callback: (response: EventEmitter & { statusCode: number; resume(): void }) => void) {
      calls.push(options);
      const request = new EventEmitter() as EventEmitter & { destroy(): void; setTimeout(ms: number, callback: () => void): void };
      request.destroy = () => undefined; request.setTimeout = () => undefined;
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; resume(): void };
        response.statusCode = 200; response.resume = () => undefined;
        callback(response);
        const next = responses.shift() ?? { ready: false };
        response.emit('data', Buffer.from(JSON.stringify(next)));
        if (!(next && typeof next === 'object' && 'neverEnd' in next)) response.emit('end');
      });
      return request;
    },
  };
  const run = () => runInNewContext(NETWORK_BOOTSTRAP_SOURCE, {
    require(name: string) {
      if (name === 'node:http') return http;
      if (name === 'node:os') return { constants: { signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } } };
      if (name === 'node:child_process') return {
        spawn(command: string, args: string[], options: { cwd: string }) {
          assert.equal(command, '/usr/local/bin/node');
          assert.equal(args[0], '/usr/src/node-red/node_modules/node-red/red.js');
          assert.equal(options.cwd, '/usr/src/node-red');
          events.push('start-node-red'); loaded.emit('loaded'); return child;
        },
      };
      throw new Error('unexpected non-core bootstrap dependency');
    },
    process, Buffer, console: { error: () => undefined, log: () => undefined },
    Date: { now: () => clock },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer; timers.add(id);
      setImmediate(() => { if (timers.delete(id)) { clock += delay; callback(); } }); return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return { run, process, child, events, calls, loaded };
}

test('trusted entrypoint blocks Node-RED until readiness matches its exact network', async () => {
  const f = fixture([{ ready: false }, { ready: true, networkId: 'b'.repeat(64) }, { ready: true, networkId: 'a'.repeat(64) }]);
  const done = new Promise<void>(resolve => f.loaded.once('loaded', resolve));
  f.run(); await done;
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.hostname === '172.30.0.1' && call.port === 31555));
  assert.deepEqual(f.events, ['start-node-red']);
  f.process.emit('SIGTERM'); assert.deepEqual(f.events, ['start-node-red', 'signal:SIGTERM']);
  f.child.emit('close', null, 'SIGTERM'); assert.equal(f.events.at(-1), 'exit:143');
});

test('a readiness response that never ends cannot defeat the absolute request deadline', async () => {
  const blocked = fixture(Array.from({ length: 200 }, () => ({ neverEnd: true })));
  blocked.run();
  for (let i = 0; i < 1000 && !blocked.events.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(blocked.events, ['exit:78']);
});

test('a real slow-drip HTTP response is aborted by the absolute two-second timer', { timeout: 6000 }, async t => {
  let ended!: () => void, openedAt = 0, closedAt = 0, childStarted = false;
  const closed = new Promise<void>(resolve => { ended = resolve; });
  const server = http.createServer((_request, response) => {
    openedAt = Date.now(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
    const interval = setInterval(() => response.write(' '), 50);
    response.once('close', () => { clearInterval(interval); closedAt = Date.now(); ended(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bootstrapProcess = new EventEmitter() as EventEmitter & { env: Record<string, string>; exit(code: number): void };
  bootstrapProcess.env = { TLE_NETWORK_GUARD_ID: 'a'.repeat(64), TLE_NETWORK_GUARD_GATEWAY: '127.0.0.1', TLE_NETWORK_GUARD_PORT: String(address.port) };
  bootstrapProcess.exit = () => undefined;
  t.after(() => { bootstrapProcess.emit('SIGTERM'); server.closeAllConnections(); server.close(); });
  runInNewContext(NETWORK_BOOTSTRAP_SOURCE, {
    require(name: string) {
      if (name === 'node:http') return http;
      if (name === 'node:os') return { constants: osConstants };
      if (name === 'node:child_process') return { spawn: () => { childStarted = true; return new EventEmitter(); } };
      throw new Error('unexpected bootstrap dependency');
    }, process: bootstrapProcess, Buffer, setTimeout, clearTimeout, console: { error: () => undefined },
  });
  await closed;
  assert.equal(childStarted, false);
  assert.ok(closedAt - openedAt >= 1800 && closedAt - openedAt < 3500);
});

test('absent or malformed guard configuration never starts Node-RED', () => {
  const f = fixture([]); f.process.env['TLE_NETWORK_GUARD_ID'] = 'invalid'; f.run();
  assert.deepEqual(f.events, ['exit:78']); assert.equal(f.calls.length, 0);
});

test('readiness waiting has a finite deadline and preserves ordinary child exit codes', async () => {
  const blocked = fixture([]);
  blocked.run();
  for (let i = 0; i < 1000 && !blocked.events.some(value => value.startsWith('exit:')); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(blocked.events, ['exit:78']);
  const ready = fixture([{ ready: true, networkId: 'a'.repeat(64) }]);
  const done = new Promise<void>(resolve => ready.loaded.once('loaded', resolve));
  ready.run(); await done; ready.child.emit('close', 7, null);
  assert.equal(ready.events.at(-1), 'exit:7');
  assert.deepEqual(networkBootstrapEntrypoint(), ['/usr/local/bin/node', '-e', NETWORK_BOOTSTRAP_SOURCE]);
});
