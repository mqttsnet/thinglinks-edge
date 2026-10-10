import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authTokenKeyFor } from '../../core/config.ts';
import { recordAudit } from '../../core/db.ts';
import { canInstance } from '../../core/auth/authz.ts';
import type { SessionUser } from '../../core/auth/service.ts';
import { SID, type HttpContext } from '../context.ts';

export function editorScope(ctx: HttpContext, user: SessionUser, id: string): 'read' | '*' {
  return canInstance(user.role, 'instance:operate', user.role === 'admin' ? undefined : ctx.users.grantFor(user.username, id)) ? '*' : 'read';
}

/** The instance is a lower-trust peer, including during its authentication response. */
async function readTokenResponse(response: Response | undefined): Promise<Record<string, unknown> | undefined> {
  if (!response?.ok || !response.body) { await response?.body?.cancel().catch(() => undefined); return undefined; }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) return undefined;
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Explicit password verification supplements, and never replaces, Manager authorization. */
export function registerEditorAccess(api: FastifyInstance, ctx: HttpContext): void {
  const route = `${ctx.config.basePath}/api/instances/:id/editor-access`;
  const noStore = (reply: Parameters<HttpContext['guard']>[1]) => reply
    .header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');

  api.get(route, async (req, reply) => {
    noStore(reply);
    const { id } = req.params as { id: string };
    const user = ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id });
    if (!user) return;
    if (!ctx.repo.get(id)) return reply.code(404).send({ error: '实例不存在' });
    const lease = ctx.editorAccess.check({ sessionId: req.cookies[SID] ?? '', username: user.username, instanceId: id, scope: editorScope(ctx, user, id) });
    return reply.send({ unlocked: !!lease, expiresAt: lease?.expiresAt ?? null });
  });

  api.post(route, async (req, reply) => {
    noStore(reply);
    const { id } = req.params as { id: string };
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:view', instance: id });
    if (!user) return;
    const instance = ctx.repo.get(id);
    if (!instance) return reply.code(404).send({ error: '实例不存在' });
    const body = req.body as { password?: unknown } | null;
    const password = body && !Array.isArray(body) ? body.password : undefined;
    if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password, 'utf8') > 72) {
      return reply.code(400).send({ error: '请输入实例编辑器密码，长度不得超过 72 个 UTF-8 字节' });
    }
    const sessionId = req.cookies[SID] ?? '';
    const attempt = ctx.editorAccess.attempt(user.username, id);
    if (!attempt.allowed) return reply.code(429).header('retry-after', attempt.retryAfterSeconds).send({ error: '验证过于频繁，请稍后重试' });
    const credential = ctx.repo.credentials(id)[0];
    const credentialVersion = ctx.editorAccess.credentialVersion(id);
    const generation = ctx.editorAccess.generation;
    if (!credential || !credentialVersion) return reply.code(500).send({ error: '实例无可用账号' });
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
    if (!timingSafeEqual(digest(password), digest(credential.password))) {
      recordAudit(ctx.db, { actor: user.username, action: 'editor.unlock', target: id, result: 'fail' });
      return reply.code(401).send({ error: '实例编辑器密码不正确' });
    }
    const scope = editorScope(ctx, user, id);
    const result = await fetch(`${ctx.upstreamFor(id)}${instance.adminRoot}auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'node-red-editor', grant_type: 'password', scope, username: credential.username, password }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    }).catch(() => undefined);
    const raw = await readTokenResponse(result);
    // Node-RED 5 omits scope in its normal OAuth response. A supplied broader scope
    // must not be accepted; the proxy still enforces Manager permissions per request.
    if (!raw || typeof raw.access_token !== 'string' || !raw.access_token || raw.access_token.length > 16_384
      || raw.token_type !== 'Bearer' || (raw.scope !== undefined && raw.scope !== scope)) {
      recordAudit(ctx.db, { actor: user.username, action: 'editor.unlock', target: id, result: 'fail' });
      return reply.code(502).send({ error: '实例编辑器认证失败，请检查实例运行状态' });
    }
    const current = ctx.guard(req, reply, { csrf: true, need: 'instance:view', instance: id });
    if (!current) return;
    if (current.username !== user.username || editorScope(ctx, current, id) !== scope) return reply.code(403).send({ error: '实例授权已变化，请重新验证' });
    let expiresAt: number;
    try {
      ({ expiresAt } = ctx.editorAccess.grant({ sessionId, username: user.username, instanceId: id, scope }, { credentialVersion, generation }));
    } catch {
      return reply.code(409).send({ error: '实例授权状态已变化或容量已满，请重新验证' });
    }
    recordAudit(ctx.db, { actor: user.username, action: 'editor.unlock', target: id, result: 'ok' });
    const identity = { sessionId, username: user.username, instanceId: id, scope };
    const token = { access_token: raw.access_token, token_type: 'Bearer' as const, scope,
      ...(typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) && raw.expires_in > 0 ? { expires_in: raw.expires_in } : {}) };
    try {
      const handoff = ctx.editorOrigins.issueHandoff({ ...identity, token,
        storageKey: authTokenKeyFor(instance.adminRoot), adminRoot: instance.adminRoot,
        ...(req.headers.origin ? { mainOrigin: req.headers.origin } : {}) }, () => {
        const latest = ctx.auth.peek(sessionId);
        return !!latest && latest.username === user.username && !latest.mustChangePassword && !latest.mustEnroll2fa
          && canInstance(latest.role, 'instance:view', latest.role === 'admin' ? undefined : ctx.users.grantFor(latest.username, id))
          && editorScope(ctx, latest, id) === scope
          && ctx.editorAccess.check(identity)?.expiresAt === expiresAt
          && ctx.editorAccess.credentialVersion(id) === credentialVersion;
      });
      return reply.send({ ...handoff, expiresAt });
    } catch {
      ctx.editorAccess.revokeSession(sessionId, id);
      return reply.code(503).send({ error: '独立编辑器入口暂不可用，请稍后重试' });
    }

  });

  api.delete(route, async (req, reply) => {
    noStore(reply);
    const { id } = req.params as { id: string };
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:view', instance: id });
    if (!user) return;
    const sessionId = req.cookies[SID] ?? '';
    ctx.editorAccess.revokeSession(sessionId, id);
    ctx.proxySessions.closeSession(sessionId, id);
    recordAudit(ctx.db, { actor: user.username, action: 'editor.lock', target: id, result: 'ok' });
    return reply.send({ ok: true });
  });
}
