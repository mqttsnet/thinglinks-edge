/** Legacy entry remains a link, but can no longer exchange stored passwords for a token. */
import type { FastifyInstance } from 'fastify';
import type { HttpContext } from '../context.ts';

export function registerSso(api: FastifyInstance, ctx: HttpContext): void {
  api.get(`${ctx.config.basePath}/red/:id/sso`, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const { id } = req.params as { id: string };
    if (!ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;
    if (!ctx.repo.get(id)) return reply.code(404).send({ error: '实例不存在' });
    return reply.redirect(`${ctx.config.basePath}/instances?editor=${encodeURIComponent(id)}`);
  });
}
