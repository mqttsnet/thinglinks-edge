/**
 * 用户与实例授权矩阵的管理接口（T4.4）。
 *
 * 全部要求 `user:manage`（只有 admin 有）。
 * 新建与重置口令返回的一次性明文**只出现这一次**，不落库、不重复查询。
 */
import type { FastifyInstance } from 'fastify';
import { UserError } from '../../core/auth/user-repo.ts';
import { describeRole, ROLES, type GrantLevel, type Role } from '../../core/auth/authz.ts';
import { recordAudit } from '../../core/db.ts';
import type { HttpContext } from '../context.ts';

export function registerUsers(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, guard, users, repo, auth } = ctx;

  const fail = (reply: any, e: unknown) =>
    reply.code(e instanceof UserError ? 400 : 500).send({ error: (e as Error).message });

  /** 当前登录者自己的权限，前端据此隐藏按钮 —— 但后端仍然逐个路由判 */
  api.get(`${config.basePath}/api/me/permissions`, async (req, reply) => {
    const user = guard(req, reply, { csrf: false, need: 'system:view' });
    if (!user) return;
    return reply.send({
      ...describeRole(user.role),
      instances: user.role === 'admin' ? 'all' : users.grants(user.username),
    });
  });

  api.get(`${config.basePath}/api/users`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false, need: 'user:manage' })) return;
    return reply.send({ users: users.list(), roles: ROLES, grants: users.matrix() });
  });

  api.post(`${config.basePath}/api/users`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username, role } = (req.body ?? {}) as { username?: string; role?: Role };
    try {
      const password = users.create(String(username ?? ''), (role ?? 'viewer') as Role, actor.username);
      recordAudit(db, { actor: actor.username, action: 'create-user', target: String(username), result: 'ok' });
      // 明文只在这里出现一次
      return reply.code(201).send({ username, role: role ?? 'viewer', password });
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/users/:username/role`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username } = req.params as { username: string };
    const { role } = (req.body ?? {}) as { role?: Role };
    try {
      users.setRole(username, (role ?? '') as Role);
      recordAudit(db, { actor: actor.username, action: 'set-role', target: username, detail: String(role), result: 'ok' });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/users/:username/disabled`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username } = req.params as { username: string };
    const { disabled } = (req.body ?? {}) as { disabled?: boolean };
    try {
      users.setDisabled(username, disabled === true);
      recordAudit(db, { actor: actor.username, action: disabled ? 'disable-user' : 'enable-user',
                        target: username, result: 'ok' });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/users/:username/password/reset`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username } = req.params as { username: string };
    try {
      const password = users.resetPassword(username);
      /*
       * 重置口令必须当场踢掉那个人已有的会话。
       * 重置的场景往往是「他的凭据可能泄漏了」或「这个人不该再进来了」——
       * 旧会话还活着的话，这个动作等于没做。
       * （AuthService.resolve 里的凭据比对也会兜住，这里是立刻生效那一层。）
       */
      const kicked = auth.revokeUser(username);
      recordAudit(db, { actor: actor.username, action: 'reset-user-password', target: username,
                        detail: `踢下线 ${kicked} 个会话`, result: 'ok' });
      return reply.send({ username, password });
    } catch (e) { return fail(reply, e); }
  });

  // ── 实例授权矩阵 ──────────────────────────────────────────

  api.post(`${config.basePath}/api/users/:username/grants`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username } = req.params as { username: string };
    const { instanceId, level } = (req.body ?? {}) as { instanceId?: string; level?: GrantLevel };
    if (!instanceId || !repo.get(instanceId)) {
      return reply.code(400).send({ error: `实例 ${instanceId} 不存在` });
    }
    try {
      users.grant(username, instanceId, (level ?? 'view') as GrantLevel, actor.username);
      recordAudit(db, { actor: actor.username, action: 'grant-instance',
                        target: `${username}@${instanceId}`, detail: String(level), result: 'ok' });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  api.delete(`${config.basePath}/api/users/:username/grants/:instanceId`, async (req, reply) => {
    const actor = guard(req, reply, { csrf: true, need: 'user:manage' });
    if (!actor) return;
    const { username, instanceId } = req.params as { username: string; instanceId: string };
    users.revoke(username, instanceId);
    recordAudit(db, { actor: actor.username, action: 'revoke-instance',
                      target: `${username}@${instanceId}`, result: 'ok' });
    return reply.code(204).send();
  });
}
