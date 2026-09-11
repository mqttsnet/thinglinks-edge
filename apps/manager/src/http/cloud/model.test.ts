import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerCloudModel } from './model.ts';
import type { HttpContext } from '../context.ts';
test('model query requires explicit product/version and template permission without disguising transport failures', async () => {
    const app = Fastify();
    const calls: any[] = [];
    const guards: any[] = [];
    let fail = false;
    registerCloudModel(app, { config: { basePath: '' }, guard: (_req: unknown, _reply: unknown, options: unknown) => { guards.push(options); return { username: 'viewer' }; }, cloud: { fetchModel: async (request: unknown) => { calls.push(request); if (fail)
                throw new Error('offline'); return { model: { productIdentification: 'product', services: [] }, versionNo: 'version', pages: 1 }; } } } as unknown as HttpContext);
    try {
        const missing = await app.inject({ method: 'POST', url: '/api/cloud/model/query', payload: { productIdentification: 'product' } });
        assert.equal(missing.statusCode, 400);
        assert.equal(calls.length, 0);
        const good = await app.inject({ method: 'POST', url: '/api/cloud/model/query', payload: { productIdentification: 'product', versionNo: 'version' } });
        assert.equal(good.statusCode, 200);
        assert.equal(good.json().versionNo, 'version');
        assert.deepEqual(guards.at(-1), { csrf: true, need: 'template:view' });
        fail = true;
        const bad = await app.inject({ method: 'POST', url: '/api/cloud/model/query', payload: { productIdentification: 'product', versionNo: 'version' } });
        assert.equal(bad.statusCode, 502);
        assert.equal(bad.json().model, undefined);
    }
    finally {
        await app.close();
    }
});
