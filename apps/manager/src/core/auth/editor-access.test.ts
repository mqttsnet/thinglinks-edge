import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorAccessStore } from './editor-access.ts';

const a = { sessionId: 'session-a', username: 'operator-a', instanceId: 'line-a', scope: '*' as const };

test('editor access is bound to session, instance, account, grant, credential version and expiry', () => {
  let now = 100;
  let credential = { username: 'admin', password: 'original-password' };
  const store = new EditorAccessStore({ credentialFor: () => credential, now: () => now, ttlMs: 1000 });
  const lease = store.grant(a);
  assert.equal(lease.expiresAt, 1100);
  assert.ok(store.check(a));
  assert.equal(store.check({ ...a, sessionId: 'session-b' }), undefined);
  assert.equal(store.check({ ...a, instanceId: 'line-b' }), undefined);
  assert.equal(store.check({ ...a, username: 'operator-b' }), undefined);
  assert.equal(store.check({ ...a, scope: 'read' }), undefined);
  store.grant(a);
  credential = { ...credential, password: 'changed-password' };
  assert.equal(store.check(a), undefined);
  credential = { ...credential, password: 'original-password' };
  assert.equal(store.check(a), undefined, 'restoring a password cannot resurrect an invalidated lease');
  store.grant(a);
  now = 1100;
  assert.equal(store.check(a), undefined);
});

test('revocations remove only their intended session, user and instance', () => {
  const store = new EditorAccessStore({ credentialFor: () => ({ username: 'admin', password: 'fake' }) });
  const b = { ...a, instanceId: 'line-b' };
  const c = { ...a, username: 'operator-b', sessionId: 'session-b' };
  store.grant(a); store.grant(b); store.grant(c);
  store.revokeUser(a.username, a.instanceId);
  assert.equal(store.check(a), undefined);
  assert.ok(store.check(b)); assert.ok(store.check(c));
  store.grant(a);
  store.revokeSession(a.sessionId);
  assert.equal(store.check(a), undefined); assert.equal(store.check(b), undefined); assert.ok(store.check(c));
});

test('password attempts and active leases are bounded without discarding active protection', () => {
  let now = 0;
  const store = new EditorAccessStore({ credentialFor: () => ({ username: 'admin', password: 'fake' }), now: () => now, maxEntries: 2 });
  for (let i = 0; i < 5; i++) assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
  assert.equal(store.attempt(a.username, a.instanceId).allowed, false);
  assert.equal(store.attempt('operator-b', 'line-b').allowed, true);
  assert.equal(store.attempt('operator-c', 'line-c').allowed, false);
  now += 5 * 60_000;
  assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
  store.grant(a);
  store.grant({ ...a, sessionId: 'session-b' });
  assert.throws(() => store.grant({ ...a, sessionId: 'session-c' }), /容量/);
  assert.ok(store.check(a));
});

test('editor password failures follow account and instance across logout and new sessions', () => {
  const store = new EditorAccessStore({ credentialFor: () => ({ username: 'admin', password: 'fake' }) });
  for (let i = 0; i < 5; i++) assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
  store.revokeSession(a.sessionId);
  store.revokeUser(a.username);
  assert.equal(store.attempt(a.username, a.instanceId).allowed, false, 'logout and renewed access cannot clear failures');
  assert.equal(store.attempt('another-operator', a.instanceId).allowed, true);
  assert.equal(store.attempt(a.username, 'line-b').allowed, true);
  store.grant({ ...a, sessionId: 'new-manager-session' });
  assert.equal(store.attempt(a.username, a.instanceId).allowed, true, 'verified success resets this account/instance bucket');
});

test('changing instance credentials starts a new failure window without resetting other instances', () => {
  let password = 'old-instance-password';
  const store = new EditorAccessStore({ credentialFor: id => ({ username: 'admin', password: id === a.instanceId ? password : 'unchanged-password' }) });
  for (let i = 0; i < 5; i++) {
    assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
    assert.equal(store.attempt(a.username, 'line-b').allowed, true);
  }
  assert.equal(store.attempt(a.username, a.instanceId).allowed, false);
  password = 'rotated-instance-password';
  for (let i = 0; i < 5; i++) assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
  assert.equal(store.attempt(a.username, a.instanceId).allowed, false);
  assert.equal(store.attempt(a.username, 'line-b').allowed, false);
});

test('successful verification clears only that account and instance failure bucket', () => {
  const store = new EditorAccessStore({ credentialFor: () => ({ username: 'admin', password: 'fake' }) });
  for (let i = 0; i < 5; i++) {
    store.attempt(a.username, a.instanceId);
    store.attempt('another-operator', a.instanceId);
    store.attempt(a.username, 'line-b');
  }
  store.grant({ ...a, sessionId: 'verified-from-new-session' });
  assert.equal(store.attempt(a.username, a.instanceId).allowed, true);
  assert.equal(store.attempt('another-operator', a.instanceId).allowed, false);
  assert.equal(store.attempt(a.username, 'line-b').allowed, false);
});
