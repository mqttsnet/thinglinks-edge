import type { FastifyInstance } from 'fastify';
import type { HttpContext } from '../context.ts';
import { ingestInstance } from './ingest-auth.ts';
import { diagnosticFailed } from '../instance/protocol-diagnostics.ts';
export function registerEdgeProtocolDiagnostics(api: FastifyInstance, ctx: HttpContext): void {
  const service = ctx.protocolDiagnostics!;
  const base = `${ctx.config.basePath}/api/edge/protocol-diagnostics/:taskId`;
  api.post(`${base}/claim`, { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const instanceId = ingestInstance(ctx.repo, request, reply);
    if (!instanceId)
      return;
    const { taskId } = request.params as {
      taskId: string;
    };
    try {
      return reply.send(service.claim(instanceId, taskId, request.body));
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
  api.post(`${base}/result`, { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const instanceId = ingestInstance(ctx.repo, request, reply);
    if (!instanceId)
      return;
    const { taskId } = request.params as {
      taskId: string;
    };
    try {
      return reply.send({ task: service.complete(instanceId, taskId, request.body) });
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
}
