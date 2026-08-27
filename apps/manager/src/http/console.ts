/** 控制台静态资源托管。 */
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EdgeConfig } from '../core/config.ts';

export function registerConsole(app: FastifyInstance, config: EdgeConfig, webRoot: string): void {
  const injected = readFileSync(join(webRoot, 'index.html'), 'utf8').replace(
    /<head>/i,
    `<head>\n    <base href="${config.basePath}/">` +
      `\n    <script>window.__TLE_BASE__=${JSON.stringify(config.basePath)}</script>`,
  );

  app.register(fastifyStatic, {
    root: webRoot,
    prefix: `${config.basePath}/`,
    // 首页一律走下面注入过的版本，不让静态插件直接吐原始 index.html
    index: false,
    setHeaders(res, filePath) {
      // Vite 产物带内容哈希，可以长缓存；其余每次都要回源校验
      res.header(
        'cache-control',
        /-[0-9a-zA-Z_-]{8,}\.(?:js|css|woff2?|svg|png|ico)$/.test(filePath)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });

  const sendIndex = (reply: import('fastify').FastifyReply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(injected);

  /*
   * 入口地址必须显式注册。挂根路径时 `/` 会落到静态插件的通配路由上，
   * 而它对「目录」的回应是 **403**，不是 404，兜底逻辑根本接不到。
   * 挂子路径时还要把不带尾斜杠的形态一并收下。
   */
  for (const route of config.basePath ? [config.basePath, `${config.basePath}/`] : ['/']) {
    app.get(route, async (_req, reply) => sendIndex(reply));
  }

  /*
   * SPA 深链接兜底：/instances、/health 这类前端路由在服务端没有对应文件。
   * 但 /api 下的未知路径必须仍然返回 JSON 404 —— 否则前端会把一段 HTML
   * 当成接口响应去解析，报出的错与真实原因毫无关系。
   * 同理，basePath 之外的路径不归控制台管，照常 404。
   */
  app.setNotFoundHandler((req, reply) => {
    const inConsole = req.url.startsWith(`${config.basePath}/`);
    if (req.method !== 'GET' || !inConsole || req.url.startsWith(`${config.basePath}/api/`)) {
      return reply.code(404).send({ error: '资源不存在' });
    }
    return sendIndex(reply);
  });
}
