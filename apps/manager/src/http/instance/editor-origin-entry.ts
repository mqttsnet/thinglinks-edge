import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SID, type HttpContext } from '../context.ts';
import { editorScope } from './editor-access.ts';

/** The Node-RED token is handed to the dedicated instance origin, never Manager localStorage. */
export function registerEditorOriginEntry(app: FastifyInstance, ctx: HttpContext): void {
  const root = `${ctx.config.basePath}/red/:id`;
  app.get(`${root}/editor-entry`, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff');
    const { id } = req.params as { id: string };
    if (!ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id })) return;
    const instance = ctx.repo.get(id);
    if (!instance) return reply.code(404).send({ error: '实例不存在' });
    const nonce = randomBytes(18).toString('base64');
    reply.header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const endpoint = JSON.stringify(`${instance.adminRoot}editor-handoff`).replace(/</g, '\\u003c');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在打开实例编辑器</title><p id="status">正在验证编辑器入口…</p><script nonce="${nonce}">
      (async function () {
        const ticket = location.hash.slice(1);
        history.replaceState(null, '', location.pathname);
        try {
          if (!ticket) throw new Error('请从 Edge 实例页面重新验证编辑器密码');
          const response = await fetch(${endpoint}, { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
          if (!response.ok) throw new Error('编辑器入口已失效，请返回 Edge 实例页面重新验证');
          const data = await response.json();
          localStorage.setItem(data.storageKey, JSON.stringify(data.token));
          location.replace(data.adminRoot);
        } catch (error) {
          document.getElementById('status').textContent = error.message || '编辑器暂时无法打开，请返回 Edge 重试';
        }
      })();
    </script></html>`);
  });

  app.post(`${root}/editor-handoff`, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const { id } = req.params as { id: string };
    if (!ctx.editorOrigins.matchesOrigin(id, req.headers.origin)) return reply.code(403).send({ error: '编辑器 Origin 不被允许' });
    const user = ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id });
    if (!user) return;
    const body = req.body as { ticket?: unknown } | null;
    const ticket = body && !Array.isArray(body) ? body.ticket : undefined;
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return reply.code(401).send({ error: '编辑器入口已失效，请重新验证' });
    const result = ctx.editorOrigins.consumeHandoff(ticket, { sessionId: req.cookies[SID] ?? '', username: user.username,
      instanceId: id, scope: editorScope(ctx, user, id) });
    if (!result) return reply.code(401).send({ error: '编辑器入口已失效，请重新验证' });
    return reply.send(result);
  });
}
