import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HttpContext } from '../context.ts';
import type { CommandBridge } from '../../core/cloud/commands/bridge.ts';
import { CommandError } from '../../core/cloud/commands/types.ts';
import { ingestInstance } from './ingest-auth.ts';

function failed(reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.status).send({ error: error.message });
  throw error;
}

export function registerEdgeCommands(api: FastifyInstance, ctx: HttpContext, bridge: CommandBridge): void {
  const base = ctx.config.basePath;
  api.post(`${base}/api/edge/command-bindings`, async (request, reply) => {
    const instanceId = ingestInstance(ctx.repo, request, reply);
    if (!instanceId) return;
    try { return reply.send(bridge.registerBindings(instanceId, request.body)); }
    catch (error) { return failed(reply, error); }
  });
  api.post(`${base}/api/edge/commands/next`, async (request, reply) => {
    const instanceId = ingestInstance(ctx.repo, request, reply);
    if (!instanceId) return;
    try { return reply.send({ command: bridge.next(instanceId, request.body) }); }
    catch (error) { return failed(reply, error); }
  });
  api.post(`${base}/api/edge/commands/:id/result`, async (request, reply) => {
    const instanceId = ingestInstance(ctx.repo, request, reply);
    if (!instanceId) return;
    const { id } = request.params as { id: string };
    try { return reply.send({ command: await bridge.complete(instanceId, id, request.body) }); }
    catch (error) { return failed(reply, error); }
  });
  api.get(`${base}/api/commands`, async (request, reply) => {
    const query = request.query as { instanceId?: string; nodeId?: string; limit?: string };
    const user = ctx.guard(request, reply, query.instanceId === undefined
      ? { csrf: false, need: 'field:view' }
      : { csrf: false, need: 'instance:view', instance: query.instanceId });
    if (!user) return;
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: 'limit必须为1至200' });
    const visible = ctx.visibleOnly(user, bridge.list(query.instanceId));
    return reply.send({ commands: visible.filter(row => query.nodeId === undefined || row.deviceIdentification === query.nodeId).slice(0, limit) });
  });
}
