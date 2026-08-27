/**
 * Manager HTTP 服务：控制台 API + 实例反代。
 *
 * 反代放在主程序内而非 nginx：只需配一个域名一张证书，nginx 配置永不变；
 * 实例 1880 不映射宿主，唯一入口是本进程，鉴权因此天然统一。
 *
 * 代理层绝不做路径重写 —— prefix === rewritePrefix。已在真实 Node-RED 5.0.4 验证：
 * 剥掉前缀会丢失尾斜杠 301，且编辑器算出的 WebSocket 路径不带实例前缀而无法路由。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import httpProxy from '@fastify/http-proxy';
import { randomBytes } from 'node:crypto';
import type { EdgeConfig } from './core/config.ts';
import { authTokenKeyFor } from './core/config.ts';
import { AuthService } from './core/auth.ts';
import { InstanceRepo } from './core/instance-repo.ts';
import type { InstanceService } from './core/instance-service.ts';
import { containerName } from './core/container-spec.ts';
import { recordAudit } from './core/db.ts';
import type { Db } from './core/db.ts';

const SID = 'tle_sid';
const CSRF = 'tle_csrf';

export interface ServerDeps {
  config: EdgeConfig;
  db: Db;
  auth: AuthService;
  repo: InstanceRepo;
  service: InstanceService;
  /** 实例上游地址；默认按容器名解析（Manager 与实例同处一个 docker 网络） */
  upstreamFor?: (instanceId: string) => string;
}

const defaultUpstream = (id: string) => `http://${containerName(id)}:1880`;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, db, auth, repo, service } = deps;
  const upstreamFor = deps.upstreamFor ?? defaultUpstream;
  const app = Fastify({ logger: false, trustProxy: true });

  app.register(cookie);

  const currentUser = (req: { cookies: Record<string, string | undefined> }) =>
    auth.resolve(req.cookies[SID]);

  const instanceIdFromUrl = (url: string): string | undefined => {
    const re = new RegExp(`^${config.basePath}/red/([^/?]+)`);
    return re.exec(url)?.[1];
  };

  /*
   * API 与免密跳转放在独立插件作用域内。
   * 这样宽松的 JSON 解析器只作用于此，不与 @fastify/http-proxy 自己的
   * application/json 解析器冲突 —— Fastify 插件本身就是封装边界。
   */
  app.register(async (api) => {
    /*
     * 容忍空的 JSON 请求体：stop / delete / reset 本无请求体，
     * 但客户端（浏览器 fetch、curl）习惯性带 content-type: application/json，
     * Fastify 默认会因此 400。这是真实客户端的常见行为，服务端应当接受。
     */
    api.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const text = String(body).trim();
      if (text === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }), undefined);
      }
    });

  // ── 会话 ────────────────────────────────────────────────

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

  // ── 实例 ────────────────────────────────────────────────

  /** 需登录；改状态的接口额外校验 CSRF */
  const guard = (req: any, reply: any, opts: { csrf: boolean }) => {
    const user = currentUser(req);
    if (!user) { reply.code(401).send({ error: '未登录' }); return undefined; }
    if (opts.csrf && !AuthService.csrfOk(req.headers['x-csrf-token'], req.cookies[CSRF])) {
      reply.code(403).send({ error: 'CSRF 校验失败' }); return undefined;
    }
    return user;
  };

  const fail = (reply: any, e: unknown) =>
    reply.code(400).send({ error: (e as Error).message });

  api.get(`${config.basePath}/api/instances`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    const list = await service.list();
    return reply.send({
      instances: list.map((i) => ({ ...i, openUrl: `${config.basePath}/red/${i.id}/sso` })),
    });
  });

  api.get(`${config.basePath}/api/instances/:id`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    const view = await service.get((req.params as { id: string }).id);
    return view ? reply.send({ instance: view }) : reply.code(404).send({ error: '实例不存在' });
  });

  /** 端口推荐 —— 只作建议，用户可自行填写 */
  api.get(`${config.basePath}/api/ports/recommend`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    const count = Number((req.query as { count?: string }).count ?? '20');
    if (!Number.isInteger(count) || count < 0 || count > 200) {
      return reply.code(400).send({ error: 'count 需为 0-200 的整数' });
    }
    return reply.send({ recommended: service.recommendPorts(count) });
  });

  api.post(`${config.basePath}/api/instances`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true });
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const view = await service.create({
        id: String(b['id'] ?? ''),
        name: String(b['name'] ?? ''),
        imageTag: String(b['imageTag'] ?? ''),
        memoryMb: Number(b['memoryMb'] ?? 512),
        cpus: Number(b['cpus'] ?? 0.5),
        portSpec: String(b['portSpec'] ?? ''),
        hostIp: b['hostIp'] ? String(b['hostIp']) : undefined,
        containerPort: b['containerPort'] ? Number(b['containerPort']) : undefined,
        purpose: b['purpose'] ? String(b['purpose']) : undefined,
        actor: user.username,
      });
      return reply.code(201).send({ instance: view });
    } catch (e) { return fail(reply, e); }
  });

  for (const action of ['start', 'stop'] as const) {
    api.post(`${config.basePath}/api/instances/:id/${action}`, async (req, reply) => {
      const user = guard(req, reply, { csrf: true });
      if (!user) return;
      try {
        await service[action]((req.params as { id: string }).id, user.username);
        return reply.code(204).send();
      } catch (e) { return fail(reply, e); }
    });
  }

  api.delete(`${config.basePath}/api/instances/:id`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true });
    if (!user) return;
    // 删数据卷必须显式指定，绝不默认删数据
    const removeData = (req.query as { removeData?: string }).removeData === 'true';
    try {
      await service.remove((req.params as { id: string }).id, { removeData, actor: user.username });
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  api.post(`${config.basePath}/api/instances/:id/credentials/:username/reset`, async (req, reply) => {
    const user = guard(req, reply, { csrf: true });
    if (!user) return;
    const { id, username } = req.params as { id: string; username: string };
    try {
      const password = await service.resetCredential(id, username, user.username);
      // 新口令只在此处返回一次，之后仅以密文留存
      return reply.send({ password });
    } catch (e) { return fail(reply, e); }
  });

  // ── 健康 ────────────────────────────────────────────────

  api.get(`${config.basePath}/api/health`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    const [instances, host] = await Promise.all([service.healthAll(), service.hostStats()]);
    const summary = {
      total: instances.length,
      healthy: instances.filter((i) => i.verdict === 'healthy').length,
      degraded: instances.filter((i) => i.verdict === 'degraded').length,
      down: instances.filter((i) => i.verdict === 'down').length,
    };
    return reply.send({ summary, host, instances });
  });

  api.get(`${config.basePath}/api/instances/:id/health`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    try {
      return reply.send({ health: await service.health((req.params as { id: string }).id) });
    } catch (e) { return fail(reply, e); }
  });

  api.get(`${config.basePath}/api/instances/:id/logs`, async (req, reply) => {
    if (!guard(req, reply, { csrf: false })) return;
    const tail = Number((req.query as { tail?: string }).tail ?? '200');
    try {
      const text = await service.logs((req.params as { id: string }).id, Math.min(Math.max(tail, 1), 2000));
      return reply.type('text/plain; charset=utf-8').send(text);
    } catch (e) { return fail(reply, e); }
  });

  // ── 免密跳转 ────────────────────────────────────────────
  // 必须注册在反代之前，否则会被反代吞掉

  api.get(`${config.basePath}/red/:id/sso`, async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: '未登录' });

    const { id } = req.params as { id: string };
    const inst = repo.get(id);
    if (!inst) return reply.code(404).send({ error: `实例 ${id} 不存在` });

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

  });

  // ── 实例反代 ────────────────────────────────────────────

  app.register(httpProxy, {
    upstream: '',
    prefix: `${config.basePath}/red`,
    // 与 prefix 相同：保留完整路径前缀，绝不重写
    rewritePrefix: `${config.basePath}/red`,
    websocket: true,
    replyOptions: {
      getUpstream: (req) => {
        const id = instanceIdFromUrl(req.url ?? '');
        // 未知实例指向不可用地址，由代理层报错而非误转发
        return id && repo.get(id) ? upstreamFor(id) : 'http://127.0.0.1:1';
      },
    },
    /*
     * preHandler 同时覆盖普通请求与 WebSocket 升级 ——
     * @fastify/http-proxy 会把 upgrade 请求走正常 Fastify 路由并触发 hooks，
     * 因此鉴权与 Origin 校验都放这里。
     *
     * 注意：v11 没有 wsUpgrade 这个用户选项（同名 Symbol 是内部实现），
     * 传了会被静默忽略 —— 不要依赖它做鉴权。
     */
    preHandler: (req, reply, done) => {
      // 浏览器不对 WebSocket 施加同源策略，仅靠 Cookie 会被跨站劫持（CSWSH）
      if (!AuthService.originAllowed(req.headers.origin, config.allowedOrigins)) {
        reply.code(403).send({ error: 'Origin 不被允许' });
        return;
      }
      if (!currentUser(req)) {
        reply.code(401).send({ error: '未登录' });
        return;
      }
      const id = instanceIdFromUrl(req.url ?? '');
      if (!id || !repo.get(id)) {
        reply.code(404).send({ error: '实例不存在' });
        return;
      }
      done();
    },
  });

  app.get(`${config.basePath}/healthz`, async () => ({ ok: true }));

  return app;
}
