import type { FastifyInstance } from 'fastify';
import type { HttpContext } from '../context.ts';
import { ModelQueryError } from '../../core/cloud/model-client.ts';

export function registerCloudModel(api: FastifyInstance, ctx: HttpContext): void {
  api.post(`${ctx.config.basePath}/api/cloud/model/query`, async (request, reply) => {
    if (!ctx.guard(request, reply, { csrf: true, need: 'template:view' })) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['productIdentification', 'versionNo'].includes(key))
      || typeof body.productIdentification !== 'string' || !body.productIdentification.trim() || body.productIdentification.length > 128
      || typeof body.versionNo !== 'string' || !body.versionNo.trim() || body.versionNo.length > 128) {
      return reply.code(400).send({ error: '请明确填写产品标识和物模型绑定版本，不使用网关缺省模型' });
    }
    if (!ctx.cloud) return reply.code(503).send({ error: '云连接运行期未配置' });
    try {
      return reply.send(await ctx.cloud.fetchModel({ productIdentification: body.productIdentification.trim(), versionNo: body.versionNo.trim() }));
    } catch (error) {
      return reply.code(error instanceof ModelQueryError ? 422 : 502).send({ error: (error as Error).message });
    }
  });
}
