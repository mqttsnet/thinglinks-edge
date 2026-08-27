/**
 * 实例反代。
 *
 * 放在主程序内而非 nginx：只需配一个域名一张证书，nginx 配置永不变；
 * 实例 1880 不映射宿主，唯一入口是本进程，鉴权因此天然统一。
 *
 * 代理层绝不做路径重写 —— prefix === rewritePrefix。已在真实 Node-RED 5.0.4 验证：
 * 剥掉前缀会丢失尾斜杠 301，且编辑器算出的 WebSocket 路径不带实例前缀而无法路由。
 */
import type { FastifyInstance } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { AuthService } from '../core/auth.ts';
import type { HttpContext } from './context.ts';

export function registerProxy(app: FastifyInstance, ctx: HttpContext): void {
  const { config, repo, upstreamFor, currentUser, instanceIdFromUrl } = ctx;

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
}
