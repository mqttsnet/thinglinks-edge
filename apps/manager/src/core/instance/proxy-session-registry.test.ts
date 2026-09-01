import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProxySessionDrainTimeoutError,
  ProxySessionRegistry,
  type ProxyWebSocketSession,
} from './proxy-session-registry.ts';

test('closeAndDrain sends 1012 and completes only after every session unregisters', async () => {
  const registry = new ProxySessionRegistry();
  const events: string[] = [];
  let unregisterA = () => undefined;
  let unregisterB = () => undefined;
  const session = (name: string, unregister: () => void): ProxyWebSocketSession => ({
    close(code) {
      events.push(`close:${name}:${code}`);
      queueMicrotask(() => {
        events.push(`unregister:${name}`);
        unregister();
      });
    },
  });
  const a = session('a', () => unregisterA());
  const b = session('b', () => unregisterB());
  unregisterA = registry.register('line-a', a);
  unregisterB = registry.register('line-a', b);

  await registry.closeAndDrain('line-a', { code: 1012, timeoutMs: 100 });
  events.push('snapshot');

  assert.deepEqual(events.slice(0, 2).sort(), ['close:a:1012', 'close:b:1012']);
  assert.equal(events.at(-1), 'snapshot');
  assert.equal(registry.count('line-a'), 0);
});

test('drain timeout rejects before a caller can take its snapshot', async () => {
  const registry = new ProxySessionRegistry();
  const closeCodes: number[] = [];
  const unregister = registry.register('line-a', {
    close: (code) => { closeCodes.push(code); },
  });
  let snapshotTaken = false;

  await assert.rejects(
    async () => {
      await registry.closeAndDrain('line-a', { code: 1012, timeoutMs: 10 });
      snapshotTaken = true;
    },
    (error: unknown) => error instanceof ProxySessionDrainTimeoutError
      && /line-a/.test(error.message),
  );
  assert.deepEqual(closeCodes, [1012]);
  assert.equal(snapshotTaken, false);
  unregister();
});

test('draining one instance does not close another instance sessions', async () => {
  const registry = new ProxySessionRegistry();
  const closed: string[] = [];
  let unregisterA = () => undefined;
  const a: ProxyWebSocketSession = {
    close() {
      closed.push('line-a');
      queueMicrotask(unregisterA);
    },
  };
  const b: ProxyWebSocketSession = { close: () => { closed.push('line-b'); } };
  unregisterA = registry.register('line-a', a);
  const unregisterB = registry.register('line-b', b);

  await registry.closeAndDrain('line-a', { code: 1012, timeoutMs: 100 });
  assert.deepEqual(closed, ['line-a']);
  assert.equal(registry.count('line-b'), 1);
  unregisterB();
});

test('register is idempotent and unregister is safe to repeat', async () => {
  const registry = new ProxySessionRegistry();
  const session: ProxyWebSocketSession = { close: () => undefined };
  const first = registry.register('line-a', session);
  const second = registry.register('line-a', session);
  assert.equal(registry.count('line-a'), 1);
  first();
  const laterGeneration = registry.register('line-a', session);
  second();
  assert.equal(registry.count('line-a'), 1, 'stale disposer must not remove a later registration');
  laterGeneration();
  assert.equal(registry.count('line-a'), 0);
  await registry.closeAndDrain('line-a', { code: 1012, timeoutMs: 10 });
});
