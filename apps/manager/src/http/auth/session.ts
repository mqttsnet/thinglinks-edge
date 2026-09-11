/** 会话：登录、登出、当前用户、首次强制改密。 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { AuthService } from '../../core/auth/service.ts';
import { recordAudit } from '../../core/db.ts';
import { SID, CSRF, type HttpContext } from '../context.ts';

export function registerSession(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, auth, currentUser } = ctx;

  /** 发会话 Cookie。登录与第二因子两条路都走这里，Cookie 属性只写一遍 */
  const sendSession = (reply: any, sid: string, user: unknown) => {
    const csrf = randomBytes(16).toString('hex');
    return reply
      .setCookie(SID, sid, { httpOnly: true, path: '/', sameSite: 'lax', secure: config.cookieSecure })
      .setCookie(CSRF, csrf, { httpOnly: false, path: '/', sameSite: 'lax', secure: config.cookieSecure })
      .send({ user });
  };


  api.post(`${config.basePath}/api/login`, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或口令' });
    try {
      /*
       * 把来源 IP 带进去：登录失败计数按「IP + 用户名」分摊，
       * 否则任何人都能对着 admin 连输五次，把现场管理员锁在门外（见 service.ts）。
       * Fastify 开了 trustProxy，req.ip 已按 X-Forwarded-For 还原到真实对端。
       */
      const result = auth.login(username, password, req.ip);

      /*
       * 开了两步验证：这里**不发任何 Cookie**，只回一张一次性票据。
       * 发了就等于一步登录 —— 第二因子验不验都无所谓了。
       */
      if ('mfa' in result) {
        recordAudit(db, { actor: username, action: 'login', result: 'ok', detail: '口令通过，待第二因子' });
        return reply.send({ mfa: true, ticket: result.ticket });
      }

      recordAudit(db, { actor: username, action: 'login', result: 'ok' });
      return sendSession(reply, result.sid, result.user);
    } catch (e) {
      recordAudit(db, { actor: username, action: 'login', result: 'fail', detail: (e as Error).message });
      return reply.code(401).send({ error: (e as Error).message });
    }
  });

  /**
   * 第二因子。验证码或恢复码都收 —— 手机丢了还能靠恢复码进来，
   * 否则一台设备丢失就等于一个账号永久锁死。
   */
  api.post(`${config.basePath}/api/login/2fa`, async (req, reply) => {
    const { ticket, code } = (req.body ?? {}) as { ticket?: string; code?: string };
    if (!ticket || !code) return reply.code(400).send({ error: '缺少票据或验证码' });
    try {
      const { sid, user } = auth.verifySecondFactor(ticket, code, req.ip);
      recordAudit(db, { actor: user.username, action: 'login-2fa', result: 'ok' });
      return sendSession(reply, sid, user);
    } catch (e) {
      // 这里**不记用户名** —— 票据无效时我们本来就不知道是谁在试
      recordAudit(db, { actor: '-', action: 'login-2fa', result: 'fail', detail: (e as Error).message });
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
