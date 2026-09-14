import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.ts';
import { EditorOrigins } from './editor-origins.ts';

function fixture() {
  const db = openDb(':memory:');
  for (const id of ['line-a', 'line-b', 'line-c']) db.prepare(`INSERT INTO instance
    (id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES (?,?,?,512,0.5,?,?)`)
    .run(id, id, 'fixture', `/red/${id}/`, 'fixture');
  let now = 1_000;
  const options = { externalUrl: 'http://127.0.0.1:19100', basePath: '', portRange: { min: 19200, max: 19201 }, now: () => now,
    generationFor: (id: string) => (db.prepare('SELECT cred_secret FROM instance WHERE id = ?').get(id) as { cred_secret: string } | undefined)?.cred_secret };
  const origins = new EditorOrigins(db, options);
  return { db, options, origins, tick: (ms: number) => { now += ms; } };
}

const input = { username: 'alice', sessionId: 'local-fixture-session', instanceId: 'line-a', scope: '*' as const,
  token: { access_token: 'local-nodered-token', token_type: 'Bearer' as const, scope: '*' as const }, storageKey: 'auth-tokens-red-line-a', adminRoot: '/red/line-a/' };

test('editor origins persist unique ports and never reuse a deleted instance origin', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  assert.equal(f.origins.origin('line-a'), 'http://127.0.0.1:19200');
  assert.equal(f.origins.origin('line-b'), 'http://127.0.0.1:19201');
  assert.equal(new EditorOrigins(f.db, f.options).origin('line-b'), 'http://127.0.0.1:19201');
  f.db.prepare('DELETE FROM instance WHERE id = ?').run('line-a');
  assert.equal(f.origins.runtimeInstance(19200), undefined);
  assert.throws(() => f.origins.origin('line-c'), /端口/);
});

test('handoff keeps the node token server-side and only exchanges once for the bound identity', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const output = f.origins.issueHandoff(input, () => true);
  assert.equal(JSON.stringify(output).includes('local-nodered-token'), false);
  const url = new URL(output.editorUrl);
  assert.equal(url.origin, 'http://127.0.0.1:19200');
  assert.equal(url.pathname, '/red/line-a/editor-entry');
  assert.equal(url.search, '');
  const identity = { sessionId: input.sessionId, username: input.username, instanceId: input.instanceId, scope: input.scope };
  const exchanged = f.origins.consumeHandoff(url.hash.slice(1), identity);
  assert.deepEqual(exchanged, { token: input.token, storageKey: input.storageKey, adminRoot: input.adminRoot });
  assert.equal(f.origins.consumeHandoff(url.hash.slice(1), identity), undefined);
});

test('handoff rejects another session, another instance, expiry and revoked access', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const identity = { sessionId: input.sessionId, username: input.username, instanceId: input.instanceId, scope: input.scope };
  const ticket = (allowed = () => true) => new URL(f.origins.issueHandoff(input, allowed).editorUrl).hash.slice(1);
  assert.equal(f.origins.consumeHandoff(ticket(), { ...identity, sessionId: 'other' }), undefined);
  assert.equal(f.origins.consumeHandoff(ticket(), { ...identity, instanceId: 'line-b' }), undefined);
  const expiring = ticket(); f.tick(60_001);
  assert.equal(f.origins.consumeHandoff(expiring, identity), undefined);
  let allowed = true;
  const revoked = ticket(() => allowed); allowed = false;
  assert.equal(f.origins.consumeHandoff(revoked, identity), undefined);
});

test('revocation burns pending handoffs even after the same permission is granted again', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const ticket = new URL(f.origins.issueHandoff(input, () => true).editorUrl).hash.slice(1);
  f.origins.revokeUser('alice', 'line-a');
  assert.equal(f.origins.consumeHandoff(ticket, input), undefined);
});

test('unsafe port ranges and changed ranges fail instead of falling back to the Manager origin', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  assert.throws(() => new EditorOrigins(f.db, { ...f.options, portRange: { min: 19100, max: 19200 } }), /端口/);
  f.origins.origin('line-a');
  const changed = new EditorOrigins(f.db, { ...f.options, portRange: { min: 19300, max: 19301 } });
  assert.throws(() => changed.origin('line-a'), /端口/);
  assert.throws(() => f.origins.origin('missing'), /不存在/);
});

test('recreating the same instance id gets a fresh browser origin', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  assert.equal(f.origins.origin('line-a'), 'http://127.0.0.1:19200');
  f.db.prepare('UPDATE instance SET cred_secret = ? WHERE id = ?').run('new-generation', 'line-a');
  assert.equal(f.origins.runtimeInstance(19200), undefined);
  assert.equal(f.origins.origin('line-a'), 'http://127.0.0.1:19201');
});

test('only configured Manager origins may choose an editor hostname alias', (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const origins = new EditorOrigins(f.db, { ...f.options, allowedMainOrigins: ['http://localhost:19100'] });
  assert.equal(origins.origin('line-a', 'http://localhost:19100'), 'http://localhost:19200');
  assert.throws(() => origins.origin('line-a', 'http://attacker.example:19100'), /Origin/);
  assert.equal(origins.matchesOrigin('line-a', 'http://localhost:19200'), true);
  assert.equal(origins.matchesOrigin('line-a', 'http://localhost:19201'), false);
});
