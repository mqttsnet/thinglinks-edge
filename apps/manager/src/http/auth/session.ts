/** 会话：登录、登出、当前用户、首次强制改密。 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { AuthService } from '../core/auth.ts';
import { recordAudit } from '../core/db.ts';
import { SID, CSRF, type HttpContext } from './context.ts';

export function registerSession(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, auth, currentUser } = ctx;


  api.post(`${config.basePath}/api/login`, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或口令' });
    try {
      const { sid, user } = auth.login(username, password);
      const csrf = randomBytes(16).toString('hex');
      recordAudit(db, { actor: username, action: 'login', result: 'ok' });
      return reply
        .setCookie(SID, sid, { httpOnly: true, path: '/', sameSite: 'lax', secure: config.cookieSecure })
        .setCookie(CSRF, csrf, { httpOnly: false, path: '/', sameSite: 'lax', secure: config.cookieSecure })
        .send({ user });
    } catch (e) {
      recordAudit(db, { actor: username, action: 'login', result: 'fail', detail: (e as Error).message });
      return reply.code(401).send({ error: (e as Error).message });
    }
  });

  api.post(`${config.basePath}/api/logout`, async (req, reply) => {
    auth.logout(req.cookies[SID]);
    return reply.clearCookie(SID, { path: '/' }).code(204).send();
  });

  api.get(`${config.basePath}/api/me`, async (req, reply) => {
    const user = currentUser(req);
    return user ? reply.send({ user }) : reply.code(401).send({ error: '未登录' });
  });

  api.post(`${config.basePath}/api/change-password`, async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: '未登录' });
    if (!AuthService.csrfOk(req.headers['x-csrf-token'] as string | undefined, req.cookies[CSRF])) {
      return reply.code(403).send({ error: 'CSRF 校验失败' });
    }
    const { oldPassword, newPassword } = (req.body ?? {}) as Record<string, string>;
    try {
      auth.changePassword(user.username, oldPassword ?? '', newPassword ?? '');
      recordAudit(db, { actor: user.username, action: 'change-password', result: 'ok' });
      return reply.clearCookie(SID, { path: '/' }).code(204).send();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
