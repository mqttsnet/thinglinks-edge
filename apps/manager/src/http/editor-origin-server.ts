import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { SID, type HttpContext } from './context.ts';
import { editorScope } from './instance/editor-access.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safePath(path: string): boolean {
  let decoded = path;
  for (let i = 0; i < 4; i++) {
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part === '.' || part === '..')) return false;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      decoded = next;
    } catch { return false; }
  }
  return false;
}

/** Bind access to the actual receiving socket, never an attacker-supplied forwarded Host. */
export function registerEditorOriginGate(app: FastifyInstance, ctx: HttpContext): void {
  const cataloguePath = `${ctx.config.basePath}/npm/-/catalogue.json`;
  const catalogueRead = (method: string, path: string, upgrade: unknown) =>
    (method === 'GET' || method === 'HEAD') && path === cataloguePath && upgrade === undefined;
  app.addHook('onRequest', async (req, reply) => {
    const origins = ctx.editorOrigins;
    const port = req.raw.socket.localPort;
    const runtime = port !== undefined && port >= origins.portRange.min && port <= origins.portRange.max;
    const origin = req.headers.origin;
    const path = req.url.split('?')[0] ?? '';
    const proxyPrefix = `${ctx.config.basePath}/red/`;
    const crossOriginBrowser = req.headers['sec-fetch-site'] === 'same-site' || req.headers['sec-fetch-site'] === 'cross-site';
    if (runtime) {
      const id = origins.runtimeInstance(port);
      const editorPath = path === `${proxyPrefix}${id}` || path.startsWith(`${proxyPrefix}${id}/`);
      if (!id || (!editorPath && !catalogueRead(req.method, path, req.headers.upgrade)) || !safePath(path)) {
        return reply.code(404).send({ error: '编辑器入口不存在' });
      }
      if (!origins.matchesHost(id, req.headers.host, port)) return reply.code(403).send({ error: '编辑器入口 Host 不匹配' });
      if (origin !== undefined && (!origins.matchesOrigin(id, origin) || new URL(origin).host !== req.headers.host)) {
        return reply.code(403).send({ error: '编辑器 Origin 不被允许' });
      }
      const entryNavigation = req.method === 'GET' && path === `${proxyPrefix}${id}/editor-entry`
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (crossOriginBrowser && !entryNavigation) return reply.code(403).send({ error: '禁止跨实例浏览器请求' });
      if (!entryNavigation && !origin && req.headers.referer) {
        let refererOrigin: string;
        try { refererOrigin = new URL(req.headers.referer).origin; } catch { return reply.code(403).send({ error: '编辑器请求来源无效' }); }
        if (!origins.matchesOrigin(id, refererOrigin) || new URL(refererOrigin).host !== req.headers.host) {
          return reply.code(403).send({ error: '禁止跨实例浏览器请求' });
        }
      }
      return;
    }

    // Cookies are shared across ports. Reject runtime-origin writes even when a
    // malicious page can read the non-HttpOnly CSRF cookie and submit its value.
    if (!SAFE_METHODS.has(req.method) && origin !== undefined && !ctx.config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: '管理请求 Origin 不被允许' });
    }
    if (!path.startsWith(proxyPrefix)) return;
    const id = path.slice(proxyPrefix.length).split('/')[0];
    if (!id || !safePath(path)) return reply.code(403).send({ error: '编辑器必须通过独立入口访问' });
    const root = `${proxyPrefix}${id}/`;
    if (path.startsWith(`${root}api/`)) {
      if (crossOriginBrowser) return reply.code(403).send({ error: '禁止跨实例浏览器请求' });
      return;
    }
    if (req.method === 'GET' && (path === root || path === root.slice(0, -1) || path === `${root}sso`)) {
      return reply.header('cache-control', 'no-store').redirect(`${ctx.config.basePath}/instances?editor=${encodeURIComponent(id)}`);
    }
    return reply.code(403).send({ error: '编辑器必须通过独立入口访问', code: 'EDITOR_ORIGIN_REQUIRED' });
  });

  // The browser catalogue is a relative URL supplied by existing settings.js.
  // Reuse its public package-metadata handler, but admit it on an editor origin
  // only after this origin's instance has been explicitly unlocked. preHandler
  // runs after the Cookie plugin; the broad npm/download routes remain closed.
  app.addHook('preHandler', async (req, reply) => {
    if (!catalogueRead(req.method, req.url.split('?')[0] ?? '', req.headers.upgrade)) return;
    const port = req.raw.socket.localPort;
    const id = port === undefined ? undefined : ctx.editorOrigins.runtimeInstance(port);
    if (!id) return; // The main listener keeps the existing read-only registry contract.
    const user = ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id });
    if (!user) return;
    const unlocked = ctx.editorAccess.check({ sessionId: req.cookies[SID] ?? '', username: user.username,
      instanceId: id, scope: editorScope(ctx, user, id) });
    if (!unlocked) return reply.code(403).send({ error: '请先验证本实例的编辑器密码', code: 'EDITOR_UNLOCK_REQUIRED' });
  });
}

/** Additional origins use the same authenticated Fastify router and WebSocket hooks. */
export async function startEditorOriginServers(
  app: FastifyInstance,
  options: { host: string; portRange: { min: number; max: number } },
): Promise<{ close(): Promise<void> }> {
  await app.ready();
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  };
  try {
    for (let port = options.portRange.min; port <= options.portRange.max; port++) {
      const server = createServer((req, res) => { app.server.emit('request', req, res); });
      servers.push(server);
      server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      server.on('upgrade', (req, socket, head) => { app.server.emit('upgrade', req, socket, head); });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host, () => { server.off('error', reject); resolve(); });
      });
    }
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
