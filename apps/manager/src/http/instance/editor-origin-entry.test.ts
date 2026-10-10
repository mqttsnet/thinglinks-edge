import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { openDb } from '../../core/db.ts';
import { EditorOrigins } from '../../core/instance/editor-origins.ts';
import type { HttpContext } from '../context.ts';
import { registerEditorOriginEntry } from './editor-origin-entry.ts';

test('editor entry exchanges the opaque ticket on its own origin and never embeds tokens in HTML', async (t) => {
  const db = openDb(':memory:');
  const origins = new EditorOrigins(db, { externalUrl: 'http://127.0.0.1:19100', basePath: '',
    portRange: { min: 19200, max: 19201 }, generationFor: (id) => id.startsWith('line-') ? 'generation' : undefined });
  const identity = { username: 'alice', sessionId: 'fake-session', instanceId: 'line-a', scope: '*' as const };
  const input = { ...identity, token: { access_token: 'local-node-token', token_type: 'Bearer' as const, scope: '*' as const },
    storageKey: 'auth-tokens-red-line-a', adminRoot: '/red/line-a/' };
  const issue = () => new URL(origins.issueHandoff(input, () => true).editorUrl).hash.slice(1);
  const ctx = { config: { basePath: '' }, editorOrigins: origins,
    repo: { get: (id: string) => id === 'line-a' ? { adminRoot: '/red/line-a/' } : undefined },
    guard: () => ({ username: 'alice', role: 'admin' }), users: {} } as unknown as HttpContext;
  const app = Fastify(); await app.register(cookie);
  registerEditorOriginEntry(app, ctx);
  t.after(async () => { await app.close(); db.close(); });
  const page = await app.inject({ method: 'GET', url: '/red/line-a/editor-entry' });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-/);
  assert.match(page.body, /history\.replaceState/);
  assert.match(page.body, /localStorage\.setItem/);
  assert.equal(page.body.includes('local-node-token'), false);
  const ticket = issue();
  const headers = { cookie: 'tle_sid=fake-session', origin: 'http://127.0.0.1:19200' };
  const response = await app.inject({ method: 'POST', url: '/red/line-a/editor-handoff', headers, payload: { ticket } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().token.access_token, 'local-node-token');
  assert.equal(response.headers['cache-control'], 'no-store');
  const replay = await app.inject({ method: 'POST', url: '/red/line-a/editor-handoff', headers, payload: { ticket } });
  assert.equal(replay.statusCode, 401);
  const other = await app.inject({ method: 'POST', url: '/red/line-a/editor-handoff',
    headers: { ...headers, origin: 'http://127.0.0.1:19201' }, payload: { ticket: issue() } });
  assert.equal(other.statusCode, 403);
  assert.equal(other.body.includes('local-node-token'), false);
  const otherSession = await app.inject({ method: 'POST', url: '/red/line-a/editor-handoff',
    headers: { ...headers, cookie: 'tle_sid=other-session' }, payload: { ticket: issue() } });
  assert.equal(otherSession.statusCode, 401);
});
