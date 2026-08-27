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
  });

  registerProxy(app, ctx);

  app.get(`${ctx.config.basePath}/healthz`, async () => ({ ok: true }));

  // 只有显式配了 webRoot 才托管。宿主开发态走 Vite，不该由 Manager 兜底 ——
  // 兜底会让「前端没构建」表现成一个陈旧页面，而不是一眼可见的连不上。
  if (deps.webRoot && existsSync(join(deps.webRoot, 'index.html'))) {
    registerConsole(app, ctx.config, deps.webRoot);
  }

  return app;
}
