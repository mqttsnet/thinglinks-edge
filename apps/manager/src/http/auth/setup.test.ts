import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { openDb } from '../../core/db.ts';
import { setupAccessAllowed, registerSetup } from './setup.ts';
import type { HttpContext } from '../context.ts';

test('browser first setup always requires the installation token, including loopback proxies', () => {
  for (const address of ['127.0.0.1', '127.20.1.2', '::1', '::ffff:127.0.0.1', '192.0.2.10', undefined]) {
    assert.equal(setupAccessAllowed(address, undefined, undefined), false);
    assert.equal(setupAccessAllowed(address, 'fixture-install-secret', undefined), false);
    assert.equal(setupAccessAllowed(address, 'fixture-install-secret', 'wrong'), false);
    assert.equal(setupAccessAllowed(address, 'fixture-install-secret', 'fixture-install-secret'), true);
  }
});

test('installation token comparison is bounded', () => {
  assert.equal(setupAccessAllowed('127.0.0.1', 'short', 'short'), false);
  assert.equal(setupAccessAllowed('127.0.0.1', 'x'.repeat(257), 'x'.repeat(257)), false);
  assert.equal(setupAccessAllowed('192.0.2.10', 'install-secret', 'install-secret\0'), false);
  assert.equal(setupAccessAllowed('192.0.2.10', 'install-secret', 'x'.repeat(257)), false);
});

test('setup HTTP state explains missing configuration; forged forwarding cannot claim; token claims once', async () => {
  const previous = process.env.SETUP_INSTALL_TOKEN;
  try {
    for (const token of [undefined, 'fixture-install-secret']) {
      if (token === undefined) delete process.env.SETUP_INSTALL_TOKEN;
      else process.env.SETUP_INSTALL_TOKEN = token;
      const db = openDb(':memory:'); const app = Fastify(); app.register(cookie);
      let created = false;
      registerSetup(app, {
        db, config: { basePath: '', cookieSecure: false },
        auth: {
          needsSetup: () => !created,
          createFirstAdmin: () => { created = true; },
          login: () => ({ sid: 'fixture-session', user: { username: 'admin', role: 'admin' } }),
        },
      } as unknown as HttpContext);
      try {
        const state = (await app.inject('/api/setup')).json();
        assert.equal(state.requiresInstallToken, true);
        assert.equal(state.installTokenConfigured, Boolean(token));
        const missing = await app.inject({ method: 'POST', url: '/api/setup', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' }, payload: { username: 'admin', password: 'fixture-password' } });
        assert.equal(missing.statusCode, 403); assert.equal(created, false);
        if (token) {
          const input = { method: 'POST' as const, url: '/api/setup', payload: { username: 'admin', password: 'fixture-password', installToken: token } };
          assert.equal((await app.inject(input)).statusCode, 200);
          assert.equal((await app.inject(input)).statusCode, 409);
        }
      } finally { await app.close(); db.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.SETUP_INSTALL_TOKEN;
    else process.env.SETUP_INSTALL_TOKEN = previous;
  }
});
