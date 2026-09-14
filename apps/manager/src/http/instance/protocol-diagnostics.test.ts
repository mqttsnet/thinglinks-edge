import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { AuthService } from '../../core/auth/service.ts';
import { InstanceRepo } from '../../core/instance/repo.ts';
import { createContext, type ServerDeps } from '../context.ts';
import { ProxySessionRegistry } from '../../core/instance/proxy-session-registry.ts';
import { registerProtocolDiagnostics } from './protocol-diagnostics.ts';
import { registerEdgeProtocolDiagnostics } from '../edge/protocol-diagnostics.ts';
import type { ProtocolDiagnosticService } from '../../core/protocols/diagnostics/service.ts';
import { DiagnosticError } from '../../core/protocols/diagnostics/types.ts';
async function fixture() {
  const db = openDb(':memory:');
  const repo = new InstanceRepo(db, Buffer.alloc(32, 1));
  for (const id of ['a', 'b']) {
    repo.create({ id, name: id, imageTag: '5.0.4-24-minimal', memLimit: 256, cpuLimit: 0.5, adminRoot: `/red/${id}/`, credSecret: `fake-${id}`, notes: '' }, [], [{ username: 'admin', password: 'fake-password', permissions: '*' }]);
    repo.setIngestToken(id, `fake-ingest-${id}`);
  }
  const auth = new AuthService(db, Buffer.alloc(32, 1));
  let user: ReturnType<AuthService['resolve']> = { username: 'operator', role: 'operator', totpEnabled: false, mustChangePassword: false, mustEnroll2fa: false };
  auth.resolve = () => user;
  let calls = 0;
  const service = { async start() { calls++; return { id: 'task' }; }, list() { calls++; return []; }, get() { calls++; return { id: 'task' }; }, async cancel() { calls++; return { id: 'task', cleanup: 'done' }; }, claim(id: string) { calls++; if (id !== 'a')
      throw new DiagnosticError('TASK_NOT_FOUND', '试读任务不存在。', 404); return { leaseToken: 'fake-lease', deadline: 1 }; }, complete() { calls++; return { id: 'task' }; } } as unknown as ProtocolDiagnosticService;
  const ctx = createContext({ db, repo, auth, config: { basePath: '', externalUrl: 'http://127.0.0.1:19100', editorPortRange: { min: 19201, max: 19264 }, allowedOrigins: [] }, proxySessions: new ProxySessionRegistry(), protocolDiagnostics: service } as unknown as ServerDeps);
  ctx.users.create('operator', 'operator', 'admin');
  ctx.users.grant('operator', 'a', 'operate', 'admin');
  const app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as {
    cookies: Record<string, string>;
  }).cookies = { tle_sid: 'fake-session', tle_csrf: 'fake-csrf' }; });
  registerProtocolDiagnostics(app, ctx);
  registerEdgeProtocolDiagnostics(app, ctx);
  return { app, repo, ctx, get calls() { return calls; }, setUser: (value: typeof user) => { user = value; }, async close() { await app.close(); ctx.disposeEditorSessions(); db.close(); } };
}
test('all trial routes enforce the actual instance grant and write CSRF before invoking the service', async () => {
  const f = await fixture();
  try {
    for (const [method, suffix] of [['POST', '/modbus-tcp'], ['GET', ''], ['GET', '/task'], ['DELETE', '/task']] as const) {
      const r = await f.app.inject({ method, url: `/api/instances/b/protocol-diagnostics${suffix}`, headers: { 'x-csrf-token': 'fake-csrf' }, ...(method === 'POST' ? { payload: { host: 'x' } } : {}) });
      assert.equal(r.statusCode, 403);
    }
    assert.equal(f.calls, 0);
    for (const method of ['POST', 'DELETE'] as const) {
      const r = await f.app.inject({ method, url: `/api/instances/a/protocol-diagnostics/${method === 'POST' ? 'modbus-tcp' : 'task'}`, ...(method === 'POST' ? { payload: { host: 'x' } } : {}) });
      assert.equal(r.statusCode, 403);
    }
    assert.equal(f.calls, 0);
    const allowed = await f.app.inject({ method: 'POST', url: '/api/instances/a/protocol-diagnostics/modbus-tcp', headers: { 'x-csrf-token': 'fake-csrf' }, payload: { host: 'x' } });
    assert.equal(allowed.statusCode, 202);
    assert.equal(f.calls, 1);
    f.setUser(undefined);
    assert.equal((await f.app.inject('/api/instances/a/protocol-diagnostics')).statusCode, 401);
  }
  finally {
    await f.close();
  }
});
test('callbacks require the current instance ingest token and never accept request-supplied identity', async () => {
  const f = await fixture();
  try {
    const url = '/api/edge/protocol-diagnostics/task/claim';
    assert.equal((await f.app.inject({ method: 'POST', url, payload: { readerId: 'r' } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer fake-ingest-b' }, payload: { readerId: 'r', instanceId: 'a' } })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer fake-ingest-a' }, payload: { readerId: 'r' } })).statusCode, 200);
    f.repo.setIngestToken('a', 'fake-rotated');
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer fake-ingest-a' }, payload: { readerId: 'r' } })).statusCode, 401);
  }
  finally {
    await f.close();
  }
});
