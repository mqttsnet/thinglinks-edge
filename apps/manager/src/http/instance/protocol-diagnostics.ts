import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HttpContext } from '../context.ts';
import { recordAudit } from '../../core/db.ts';
import { DiagnosticError } from '../../core/protocols/diagnostics/types.ts';
import { InstanceBusyError } from '../../core/instance/operation-gate.ts';
export function diagnosticFailed(reply: FastifyReply, error: unknown) {
  if (error instanceof DiagnosticError)
    return reply.code(error.status).send({ error: error.message, code: error.code });
  if (error instanceof InstanceBusyError)
    return reply.code(409).send({ error: '实例正在执行其他操作，请稍后重试。', code: 'INSTANCE_BUSY' });
  return reply.code(503).send({ error: '试读服务暂不可用，请稍后检查任务状态。', code: 'DIAGNOSTIC_UNAVAILABLE' });
}
export function registerProtocolDiagnostics(api: FastifyInstance, ctx: HttpContext): void {
  const service = ctx.protocolDiagnostics!;
  const base = `${ctx.config.basePath}/api/instances/:id/protocol-diagnostics`;
  api.post(`${base}/modbus-tcp`, { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = request.params as {
      id: string;
    };
    const user = ctx.guard(request, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user)
      return;
    try {
      const task = await service.start(id, request.body, user.username);
      recordAudit(ctx.db, { actor: user.username, action: 'protocol-diagnostic.start', target: id, detail: task.id, result: 'accepted' });
      return reply.code(202).send({ task });
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
  api.get(base, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = request.params as {
      id: string;
    };
    if (!ctx.guard(request, reply, { csrf: false, need: 'instance:operate', instance: id }))
      return;
    try {
      return reply.send({ tasks: service.list(id) });
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
  api.get(`${base}/:taskId`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id, taskId } = request.params as {
      id: string;
      taskId: string;
    };
    if (!ctx.guard(request, reply, { csrf: false, need: 'instance:operate', instance: id }))
      return;
    try {
      return reply.send({ task: service.get(id, taskId) });
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
  api.delete(`${base}/:taskId`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { id, taskId } = request.params as {
      id: string;
      taskId: string;
    };
    const user = ctx.guard(request, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user)
      return;
    try {
      const task = await service.cancel(id, taskId);
      recordAudit(ctx.db, { actor: user.username, action: 'protocol-diagnostic.cleanup', target: id, detail: taskId, result: task.cleanup });
      return reply.send({ task });
    }
    catch (error) {
      return diagnosticFailed(reply, error);
    }
  });
}
