/**
 * Manager HTTP 服务装配。
 *
 * 这里只做「装什么、装在哪个作用域」，具体路由在 ./session ./instances ./sso
 * ./proxy ./console 各自的模块里。作用域划分是有意为之，不是风格问题 ——
 * 见下面 addContentTypeParser 处的说明。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type ServerDeps } from './context.ts';
import { registerSession } from './session.ts';
import { registerInstances } from './instances.ts';
import { registerMetrics } from './metrics.ts';
import { registerSso } from './sso.ts';
import { registerIngest } from './ingest.ts';
import { registerBackup } from './backup.ts';
import { registerUsers } from './users.ts';
import { registerVersion } from './version.ts';
import { registerProxy } from './proxy.ts';
import { registerConsole } from './console.ts';

export type { ServerDeps } from './context.ts';

export function buildServer(deps: ServerDeps): FastifyInstance {
  const ctx = createContext(deps);
  const app = Fastify({ logger: false, trustProxy: true });

  app.register(cookie);

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

    registerSession(api, ctx);
    registerInstances(api, ctx);
    registerMetrics(api, ctx);
    registerSso(api, ctx);
    registerIngest(api, ctx);
    registerBackup(api, ctx);
    registerUsers(api, ctx);
    registerVersion(api, ctx);
  });

  registerProxy(app, ctx);

  /*
   * 存活探针。带前缀的那个是给外层反代/负载均衡探的。
   *
   * 同时再注册一个**不带前缀**的 /healthz：容器自身的 HEALTHCHECK 探的是
   * 127.0.0.1:19100，那是容器内部视角，与 EXTERNAL_URL 里的挂载前缀毫无关系 ——
   * 前缀是给外层反代用的。只注册带前缀的那个，会让挂在子路径下的部署
   * （EXTERNAL_URL=https://portal.corp.com/nodered）里 HEALTHCHECK 恒定 404：
   * 容器被判 unhealthy，而进程其实完全正常。Swarm 会照着这个判断反复重启它，
   * Portainer 上则是一片红 —— 排查方向还会被带偏到「服务起不来」。
   *
   * basePath 为空时两者同路径，重复注册会让 Fastify 直接抛错，故加判断。
   */
  app.get(`${ctx.config.basePath}/healthz`, async () => ({ ok: true }));
  if (ctx.config.basePath !== '') {
    app.get('/healthz', async () => ({ ok: true }));
  }

  // 只有显式配了 webRoot 才托管。宿主开发态走 Vite，不该由 Manager 兜底 ——
  // 兜底会让「前端没构建」表现成一个陈旧页面，而不是一眼可见的连不上。
  if (deps.webRoot && existsSync(join(deps.webRoot, 'index.html'))) {
    registerConsole(app, ctx.config, deps.webRoot);
  }

  return app;
}
