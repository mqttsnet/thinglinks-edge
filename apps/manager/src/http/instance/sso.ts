/** 免密跳转：换取 Node-RED token 并注入浏览器本地存储。 */
import type { FastifyInstance } from 'fastify';
import { authTokenKeyFor } from '../core/config.ts';
import { recordAudit } from '../core/db.ts';
import { canInstance } from '../core/authz.ts';
import type { HttpContext } from './context.ts';

export function registerSso(api: FastifyInstance, ctx: HttpContext): void {
  const { config, db, repo, upstreamFor, currentUser, users } = ctx;

  // 必须注册在反代之前，否则会被反代吞掉

  api.get(`${config.basePath}/red/:id/sso`, async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: '未登录' });

    const { id } = req.params as { id: string };
    const inst = repo.get(id);
    if (!inst) return reply.code(404).send({ error: `实例 ${id} 不存在` });

    // 免密跳转直接下发实例 token，越权后果与反代等同，判定必须一致
    if (!canInstance(user.role, 'instance:view',
                     user.role === 'admin' ? undefined : users.grantFor(user.username, id))) {
      return reply.code(403).send({ error: `无权访问实例 ${id}` });
    }

    const cred = repo.credentials(id)[0];
    if (!cred) return reply.code(500).send({ error: '实例无可用账号' });

    const tokenUrl = `${upstreamFor(id)}${inst.adminRoot}auth/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'node-red-editor', grant_type: 'password', scope: '*',
        username: cred.username, password: cred.password,
      }),
    }).catch(() => undefined);

    if (!res || !res.ok) {
      recordAudit(db, { actor: user.username, action: 'sso', target: id, result: 'fail' });
      return reply.code(502).send({ error: '向实例换取令牌失败' });
    }
    const token = await res.json();

    /*
     * Node-RED 的 token 存储键按 httpAdminRoot 命名空间化（实测 5.0.4）。
     * 用固定键名会静默失效：跳转返回 200、token 也写进了本地存储，
     * 但编辑器照常弹登录页，服务端看不出任何异常。
     */
    const storageKey = authTokenKeyFor(inst.adminRoot);
    recordAudit(db, { actor: user.username, action: 'sso', target: id, result: 'ok' });

    return reply.type('text/html; charset=utf-8').send(
      `<!doctype html><meta charset="utf-8"><script>
localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(token))});
location.replace(${JSON.stringify(inst.adminRoot)});
</script>`,
    );
  });
}
