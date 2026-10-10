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
  let unregisterA: () => void = () => undefined;
  let unregisterB: () => void = () => undefined;
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
  let unregisterA: () => void = () => undefined;
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

test('revoking an instance grant closes only that user on that instance', () => {
  const registry = new ProxySessionRegistry();
  const closed: string[] = [];
  const registrations: Array<() => void> = [];
  for (const [username, instanceId] of [['alice', 'line-a'], ['alice', 'line-b'], ['bob', 'line-a']]) {
    const authorization = registry.authorize({ username: username!, instanceId: instanceId!, sessionId: username! }, () => true);
    const unregister = authorization.register({ close: () => { closed.push(`${username}@${instanceId}`); } });
    assert.ok(unregister);
    registrations.push(unregister);
  }
  registry.closeUser('alice', 'line-a');
  assert.deepEqual(closed, ['alice@line-a']);
  assert.equal(registry.count('line-a'), 1);
  assert.equal(registry.count('line-b'), 1);
  registrations.forEach((unregister) => unregister());
});

test('logout closes only the matching login session, including pending upgrades', () => {
  const registry = new ProxySessionRegistry();
  const closed: string[] = [];
  const pending = registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: 'old' }, () => true);
  const other = registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: 'other' }, () => true);
  const unregister = other.register({ close: () => { closed.push('other'); } });
  assert.ok(unregister);
  registry.closeSession('old');
  pending.register({ close: () => { closed.push('old'); } });
  assert.deepEqual(closed, ['old']);
  assert.equal(registry.count('line-a'), 1);
  unregister();
});

test('regrant cannot revive an upgrade authorized before the revocation', () => {
  const registry = new ProxySessionRegistry();
  let allowed = true;
  const pending = registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: 'sid' }, () => allowed);
  allowed = false;
  registry.closeUser('alice', 'line-a');
  allowed = true;
  const codes: number[] = [];
  pending.register({ close: (code) => { codes.push(code); } });
  assert.deepEqual(codes, [1008]);
  assert.equal(registry.count('line-a'), 0);
});

test('registration rechecks authorization and closes an expired upgrade', () => {
  const registry = new ProxySessionRegistry();
  let allowed = true;
  const pending = registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: 'sid' }, () => allowed);
  allowed = false;
  const codes: number[] = [];
  pending.register({ close: (code) => { codes.push(code); } });
  assert.deepEqual(codes, [1008]);
  assert.equal(registry.count('line-a'), 0);
});

test('authorization checks close expired sessions without requiring client traffic', async () => {
  const registry = new ProxySessionRegistry({ authorizationCheckMs: 5 });
  let allowed = true;
  let closed!: () => void;
  const closure = new Promise<void>((resolve) => { closed = resolve; });
  const pending = registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: 'sid' }, () => allowed);
  const unregister = pending.register({ close: () => { closed(); } });
  assert.ok(unregister);
  const deadline = setTimeout(() => closed(), 500);
  allowed = false;
  try {
    await closure;
    assert.equal(registry.count('line-a'), 0);
  } finally {
    clearTimeout(deadline);
    unregister();
  }
});

test('revocation terminates uncooperative sockets and continues if a close throws', () => {
  const registry = new ProxySessionRegistry();
  const terminated: string[] = [];
  for (const id of ['a', 'b']) {
    registry.authorize({ username: 'alice', instanceId: 'line-a', sessionId: id }, () => true)
      .register({ close: () => { throw new Error('closed socket'); }, terminate: () => { terminated.push(id); } });
  }
  assert.doesNotThrow(() => registry.closeUser('alice'));
  assert.deepEqual(terminated, ['a', 'b']);
  assert.equal(registry.count('line-a'), 0);
});

test('closing one editor session preserves another instance and notifies related capabilities', () => {
  const registry = new ProxySessionRegistry();
  const closed: string[] = [];
  const notifications: unknown[] = [];
  const removeListener = registry.onRevoked((target) => { notifications.push(target); });
  const releases: Array<() => void> = [];
  for (const instanceId of ['line-a', 'line-b']) {
    const release = registry.authorize({ username: 'alice', sessionId: 'sid', instanceId }, () => true)
      .register({ close: () => { closed.push(instanceId); } });
    assert.ok(release);
    releases.push(release);
  }
  registry.closeSession('sid', 'line-a');
  assert.deepEqual(closed, ['line-a']);
  assert.deepEqual(notifications, [{ sessionId: 'sid', instanceId: 'line-a' }]);
  registry.closeUser('nobody', 'line-a');
  assert.deepEqual(notifications[1], { username: 'nobody', instanceId: 'line-a' });
  removeListener();
  releases.forEach((release) => release());
});

test('authorization tickets cannot replace a tracked connection with an untracked one', () => {
  const registry = new ProxySessionRegistry();
  const closed: string[] = [];
  const ticket = registry.authorize({ username: 'alice', sessionId: 'sid', instanceId: 'line-a' }, () => true);
  const first = { close: () => { closed.push('first'); } };
  const release = ticket.register(first);
  assert.equal(ticket.register(first), release);
  ticket.register({ close: () => { closed.push('second'); } });
  assert.deepEqual(closed, ['first', 'second']);
  assert.equal(registry.count('line-a'), 0);
});
