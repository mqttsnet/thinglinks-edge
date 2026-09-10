import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerProduct } from './product.ts';
import { loadProductConfig } from '../core/product/config.ts';
import type { HttpContext } from './context.ts';

test('公开品牌读取不触发联网；更新记录需要登录权限与CSRF并遵守联网开关', async () => {
  const app = Fastify();
  let enabled = false;
  let authenticated = false;
  let calls = 0;
  const guards: unknown[] = [];
  registerProduct(app, {
    config: { basePath: '/edge' },
    settings: { get: () => ({ updateCheckEnabled: enabled }) },
    guard: (_request: unknown, reply: { code: (code: number) => { send: (body: unknown) => void } }, options: unknown) => {
      guards.push(options);
      if (!authenticated) { reply.code(401).send({ error: '未登录' }); return undefined; }
      return { username: 'viewer' };
    },
  } as unknown as HttpContext, {
    product: loadProductConfig({ PRODUCT_NAME: 'Configured product' }),
    releases: { read: async () => { calls++; return { state: 'ready', releases: [], checkedAt: '2026-09-10' }; } },
  });
  try {
    const publicInfo = await app.inject('/edge/api/product');
    assert.equal(publicInfo.statusCode, 200);
    assert.equal(publicInfo.json().product.name, 'Configured product');
    assert.equal(calls, 0);
    assert.equal(guards.length, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/edge/api/product/releases' })).statusCode, 401);
    authenticated = true;
    assert.equal((await app.inject({ method: 'POST', url: '/edge/api/product/releases' })).json().state, 'disabled');
    assert.equal(calls, 0);
    enabled = true;
    assert.equal((await app.inject({ method: 'POST', url: '/edge/api/product/releases' })).json().state, 'ready');
    assert.equal(calls, 1);
    assert.deepEqual(guards.at(-1), { csrf: true, need: 'system:view' });
  } finally { await app.close(); }
});
