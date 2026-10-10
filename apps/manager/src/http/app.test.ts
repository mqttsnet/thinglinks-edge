import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { trustProxySetting } from './app.ts';

test('forwarded address trust is disabled unless explicitly configured', () => {
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: 'false' }), false);
});

test('trusted proxies accept exact IPs, strict CIDRs and normalized aliases', () => {
  assert.deepEqual(trustProxySetting({ TRUST_PROXY: '127.0.0.1,10.0.0.0/8' }), ['127.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(trustProxySetting({ TRUST_PROXY: 'LOOPBACK, loopback' }), ['loopback']);
  for (const value of ['true', '10.0.0.0/33', '0.0.0.0/0', '::/0', '10.0.0.0/', '10.0.0.0/1e1', 'not-an-address', ',']) {
    assert.throws(() => trustProxySetting({ TRUST_PROXY: value }), /TRUST_PROXY/, value);
  }
});

test('an untrusted caller cannot replace its login rate-limit IP through forwarded headers', async () => {
  for (const env of [{}, { TRUST_PROXY: '10.10.0.5' }]) {
    const app = Fastify({ trustProxy: trustProxySetting(env) });
    app.get('/ip', req => ({ ip: req.ip }));
    try {
      const result = await app.inject({ url: '/ip', remoteAddress: '192.0.2.5', headers: { 'x-forwarded-for': '127.0.0.1' } });
      assert.deepEqual(result.json(), { ip: '192.0.2.5' });
    } finally { await app.close(); }
  }
  const app = Fastify({ trustProxy: trustProxySetting({ TRUST_PROXY: '10.10.0.5' }) });
  app.get('/ip', req => ({ ip: req.ip }));
  try {
    const result = await app.inject({ url: '/ip', remoteAddress: '10.10.0.5', headers: { 'x-forwarded-for': '192.0.2.5' } });
    assert.deepEqual(result.json(), { ip: '192.0.2.5' });
  } finally { await app.close(); }
});
