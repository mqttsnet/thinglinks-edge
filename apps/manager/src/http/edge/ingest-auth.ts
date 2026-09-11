import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceRepo } from '../../core/instance/repo.ts';

/** Read current token ownership: command polling must not retain revoked credentials. */
export function ingestInstance(
  repo: Pick<InstanceRepo, 'allIngestTokens'>,
  request: FastifyRequest,
  reply: FastifyReply,
): string | undefined {
  const authorization = request.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const instanceId = token ? repo.allIngestTokens().get(token) : undefined;
  if (!instanceId) reply.code(401).send({ error: token ? '接入令牌无效' : '缺少接入令牌' });
  return instanceId;
}
