import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { openDb } from '../../core/db.ts';
import { CommandBridge } from '../../core/cloud/commands/bridge.ts';
import { registerEdgeCommands } from './commands.ts';
import type { HttpContext } from '../context.ts';
test('command HTTP uses current ingest-token identity, isolates consumers, and filters management records', async () => {
    const db = openDb(':memory:');
    const app = Fastify();
    const tokens = new Map([['token-a', 'a'], ['token-b', 'b']]);
    const cloud = { status: () => ({ deviceIdentification: 'gateway' }), onCommand: () => () => { }, onStateChange: () => () => { }, publishCommandResponse: async () => { } };
    const bridge = new CommandBridge({ db, cloud });
    const guards: any[] = [];
    registerEdgeCommands(app, { config: { basePath: '' }, repo: { allIngestTokens: () => tokens }, guard: (_request: unknown, _reply: unknown, options: unknown) => { guards.push(options); return { username: 'operator', role: 'operator' }; }, visibleOnly: (_user: unknown, rows: any[]) => rows.filter(row => row.instanceId === 'a') } as unknown as HttpContext, bridge);
    const binding = { consumerId: 'flow-a', nodeId: 'device', serviceCode: 'control', commands: [{ cmd: 'set', param: 'value' }] };
    try {
        const unauthorized = await app.inject({ method: 'POST', url: '/api/edge/command-bindings', cookies: { sid: 'admin' }, payload: binding });
        assert.equal(unauthorized.statusCode, 401);
        const registered = await app.inject({ method: 'POST', url: '/api/edge/command-bindings', headers: { authorization: 'Bearer token-a' }, payload: binding });
        assert.equal(registered.statusCode, 200);
        await bridge.receive({ topic: '/v1/devices/gateway/command', gatewayId: 'gateway', mid: 100, body: { deviceIdentification: 'device', msgType: 'cloudReq', serviceCode: 'control', cmd: 'set', params: { value: 5 } } });
        const poll = { consumerId: 'flow-a', nodeId: 'device', serviceCode: 'control' };
        const other = await app.inject({ method: 'POST', url: '/api/edge/commands/next', headers: { authorization: 'Bearer token-b' }, payload: poll });
        assert.equal(other.statusCode, 409);
        const leased = await app.inject({ method: 'POST', url: '/api/edge/commands/next', headers: { authorization: 'Bearer token-a' }, payload: poll });
        assert.equal(leased.statusCode, 200);
        const command = leased.json().command;
        const forbidden = await app.inject({ method: 'POST', url: `/api/edge/commands/${command.id}/result`, headers: { authorization: 'Bearer token-b' }, payload: { leaseToken: command.leaseToken, ok: true } });
        assert.equal(forbidden.statusCode, 403);
        const finished = await app.inject({ method: 'POST', url: `/api/edge/commands/${command.id}/result`, headers: { authorization: 'Bearer token-a' }, payload: { leaseToken: command.leaseToken, ok: true, result: { value: 5 } } });
        assert.equal(finished.statusCode, 200);
        const listing = await app.inject({ method: 'GET', url: '/api/commands?nodeId=device' });
        assert.equal(listing.json().commands.length, 1);
        assert.equal('leaseToken' in listing.json().commands[0], false);
        assert.deepEqual(guards.at(-1), { csrf: false, need: 'field:view' });
        tokens.delete('token-a');
        const revoked = await app.inject({ method: 'POST', url: '/api/edge/commands/next', headers: { authorization: 'Bearer token-a' }, payload: poll });
        assert.equal(revoked.statusCode, 401);
    }
    finally {
        await bridge.close();
        await app.close();
        db.close();
    }
});
