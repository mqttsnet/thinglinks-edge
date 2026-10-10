/** Device credential management and the separately parsed physical-device ingress. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../../core/auth/crypto.ts';
import { recordAudit } from '../../core/db.ts';
import { InstanceBusyError } from '../../core/instance/operation-gate.ts';
import type { HttpContext } from '../context.ts';
import { IngressError } from './device-ingress/types.ts';
import { readBoundRevision } from './device-ingress/flow.ts';
import { bindingPublic, bindingRow, loadBinding, checkQuota, consumeQuota } from './device-ingress/store.ts';
import { closeIngressSessions } from './device-ingress/session.ts';
import { forward, verifyTarget } from './device-ingress/forward.ts';
import { DEFAULT_MAX_BODY, MAX_BODY, DEFAULT_RATE, MAX_RATE, MAX_CONCURRENT_REQUESTS, pathValue, instanceDevicePath, textValue, deviceIdentity, numberValue, header, verifyDeviceRequest } from './device-ingress/protocol.ts';

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof InstanceBusyError) return reply.code(409).send({ error: '实例当前忙，请稍后重试', code: error.code });
  if (error instanceof IngressError) {
    for (const [key, value] of Object.entries(error.headers ?? {})) reply.header(key, value);
    return reply.code(error.status).send({ error: error.message });
  }
  return reply.code(500).send({ error: '设备入口操作失败' });
}

function createSecret(): string { return randomBytes(32).toString('base64url'); }

export function registerDeviceIngress(api: FastifyInstance, ctx: HttpContext, options: { bodyReceiveTimeoutMs?: number } = {}): void {
  // Deployments use 10 s. An explicit shorter value supports bounded embedded
  // deployments and socket-level tests; callers cannot disable the deadline.
  const bodyReceiveTimeoutMs = options.bodyReceiveTimeoutMs ?? 10_000;
  if (!Number.isInteger(bodyReceiveTimeoutMs) || bodyReceiveTimeoutMs < 50 || bodyReceiveTimeoutMs > 10_000) throw new Error('bodyReceiveTimeoutMs must be 50..10000');
  const base = ctx.config.basePath;
  const managePath = `${base}/api/instances/:id/device-http-bindings`;
  const bindingPath = `${managePath}/:bindingId`;
  api.addHook('onClose', async () => { await closeIngressSessions(ctx); });

  api.get(managePath, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = ctx.guard(req, reply, { csrf: false, need: 'instance:view', instance: id });
    if (!user) return;
    const rows = ctx.db.prepare('SELECT * FROM device_http_binding WHERE instance_id = ? ORDER BY id').all(id) as Array<Record<string, unknown>>;
    return reply.send({ bindings: rows.map(row => bindingPublic(bindingRow(row))) });
  });

  api.post(managePath, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;
    try {
      const instance = ctx.repo.get(id) as { id: string; adminRoot: string } | undefined;
      if (!instance) throw new IngressError(404, '实例不存在');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const bindingId = b['id'] === undefined ? `http-${randomBytes(10).toString('hex')}` : textValue(b['id'], '绑定 id', 64);
      const targetPath = pathValue(b['targetPath'], 'targetPath');
      if (!instanceDevicePath(instance, targetPath)) {
        throw new IngressError(400, 'targetPath 必须位于该实例的 httpNodeRoot 下');
      }
      const deviceId = deviceIdentity(b['deviceId']);
      const maxBodyBytes = numberValue(b['maxBodyBytes'], 'maxBodyBytes', 1024, MAX_BODY, DEFAULT_MAX_BODY);
      const rateLimitPerMinute = numberValue(b['rateLimitPerMinute'], 'rateLimitPerMinute', 1, MAX_RATE, DEFAULT_RATE);
      const secret = createSecret();
      await ctx.operationGate.run(id, 'proxy-write', async () => {
        const revision = await readBoundRevision(ctx, id, targetPath, deviceId);
        ctx.db.transaction(() => {
          ctx.db.prepare(
            `INSERT INTO device_http_binding
              (id, instance_id, target_path, device_id, secret_enc, max_body_bytes, rate_limit_per_minute, created_by, flow_revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(bindingId, id, targetPath, deviceId, encryptSecret(secret, ctx.repo.key), maxBodyBytes, rateLimitPerMinute, user.username, revision);
          recordAudit(ctx.db, { actor: user.username, action: 'device-http-binding-create', target: `${id}/${bindingId}`, result: 'ok' });
        })();
      });
      return reply.header('cache-control', 'no-store').code(201).send({ binding: { id: bindingId, instanceId: id, targetPath, deviceId, enabled: true, maxBodyBytes, rateLimitPerMinute }, secret });
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE constraint')) return reply.code(409).send({ error: '绑定 id 或设备路径已存在' });
      return fail(reply, error);
    }
  });

  api.post(`${bindingPath}/revalidate`, async (req, reply) => {
    const { id, bindingId } = req.params as { id: string; bindingId: string };
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;
    const binding = loadBinding(ctx, bindingId);
    if (!binding || binding.instanceId !== id) return reply.code(404).send({ error: '绑定不存在' });
    try {
      return await ctx.operationGate.run(id, 'proxy-write', async () => {
        verifyTarget(ctx, binding);
        const revision = await readBoundRevision(ctx, id, binding.targetPath, binding.deviceId);
        ctx.db.transaction(() => {
          // Revalidation acknowledges one exact existing credential/route pair;
          // rotation, deletion or recreation during the native read invalidates it.
          const result = ctx.db.prepare(`UPDATE device_http_binding SET flow_revision = ?
            WHERE id = ? AND instance_id = ? AND target_path = ? AND device_id = ?
              AND secret_enc = ? AND flow_revision = ? AND enabled = ?`)
            .run(revision, binding.id, binding.instanceId, binding.targetPath, binding.deviceId,
              binding.secretEnc, binding.flowRevision, binding.enabled ? 1 : 0);
          if (result.changes !== 1) throw new IngressError(409, '绑定在流程确认期间已变化，请刷新后重新确认');
          recordAudit(ctx.db, { actor: user.username, action: 'device-http-binding-revalidate', target: `${id}/${bindingId}`, result: 'ok' });
        })();
        return reply.header('cache-control', 'no-store').send({ binding: bindingPublic({ ...binding, flowRevision: revision }) });
      });
    } catch (error) { return fail(reply, error); }
  });

  api.post(`${bindingPath}/rotate`, async (req, reply) => {
    const { id, bindingId } = req.params as { id: string; bindingId: string };
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;
    const binding = loadBinding(ctx, bindingId);
    if (!binding || binding.instanceId !== id) return reply.code(404).send({ error: '绑定不存在' });
    const secret = createSecret();
    try {
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE device_http_binding SET secret_enc = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(encryptSecret(secret, ctx.repo.key), binding.id);
        recordAudit(ctx.db, { actor: user.username, action: 'device-http-binding-rotate', target: `${id}/${bindingId}`, result: 'ok' });
      })();
      return reply.header('cache-control', 'no-store').send({ secret });
    } catch (error) { return fail(reply, error); }
  });

  api.delete(bindingPath, async (req, reply) => {
    const { id, bindingId } = req.params as { id: string; bindingId: string };
    const user = ctx.guard(req, reply, { csrf: true, need: 'instance:operate', instance: id });
    if (!user) return;
    try {
      ctx.db.transaction(() => {
        const result = ctx.db.prepare('DELETE FROM device_http_binding WHERE id = ? AND instance_id = ?').run(bindingId, id);
        if (result.changes === 0) throw new IngressError(404, '绑定不存在');
        recordAudit(ctx.db, { actor: user.username, action: 'device-http-binding-delete', target: `${id}/${bindingId}`, result: 'ok' });
      })();
      return reply.code(204).send();
    } catch (error) { return fail(reply, error); }
  });

  // Keep raw bytes in this plugin only. Parsing and re-stringifying JSON can
  // change whitespace, duplicate keys and large numbers before authentication.
  api.register(async ingress => {
    ingress.removeAllContentTypeParsers();
    ingress.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const active = new Map<FastifyRequest, { finishBody: () => void; release: () => void }>();
    ingress.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
      if (active.size >= MAX_CONCURRENT_REQUESTS) return reply.code(429).header('retry-after', '1').send({ error: '设备入口繁忙，请稍后重试' });
      if (req.url.includes('?')) return reply.code(400).send({ error: '设备入口不接受查询参数' });
      if (req.headers['content-encoding'] !== undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type'))) {
        return reply.code(415).send({ error: '设备入口只接受未压缩的 UTF-8 application/json' });
      }
      const binding = loadBinding(ctx, (req.params as { bindingId: string }).bindingId);
      if (!binding || !binding.enabled) return reply.code(404).send({ error: '设备入口不存在' });
      const finishBody = () => { clearTimeout(deadline); };
      const release = () => {
        finishBody(); active.delete(req);
        req.raw.off('aborted', release); reply.raw.off('close', release);
      };
      active.set(req, { finishBody, release });
      req.raw.once('aborted', release);
      reply.raw.once('close', release);
      // Absolute receive deadline, deliberately not a socket inactivity timer:
      // sending one byte periodically must not retain a global slot forever.
      const deadline = setTimeout(() => {
        release();
        if (!reply.sent) {
          reply.raw.once('finish', () => req.raw.destroy());
          void reply.code(408).header('connection', 'close').send({ error: '设备入口请求体接收超时' });
        } else req.raw.destroy();
      }, bodyReceiveTimeoutMs);
      deadline.unref();
    });
    ingress.addHook('preHandler', async req => { active.get(req)?.finishBody(); });
    ingress.addHook('onResponse', async req => { active.get(req)?.release(); });
    ingress.addHook('onTimeout', async req => { active.get(req)?.release(); });
    ingress.addHook('onClose', async () => {
      for (const [req, state] of active) { state.release(); req.raw.destroy(); }
    });
    ingress.route({
      method: 'POST', url: `${base}/api/device-ingress/:bindingId`, bodyLimit: MAX_BODY,
      handler: async (req, reply) => {
        const binding = loadBinding(ctx, (req.params as { bindingId: string }).bindingId);
        if (!binding || !binding.enabled) return reply.code(404).send({ error: '设备入口不存在' });
        if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: '请求体不能为空' });
        const body = req.body;
        if (body.length > binding.maxBodyBytes) return reply.code(413).send({ error: '请求体超过设备入口限制' });
        try {
          const target = verifyTarget(ctx, binding);
          verifyDeviceRequest(ctx, binding, req, body);
          try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
          catch { throw new IngressError(400, '请求体必须是合法的 UTF-8 JSON'); }
          const result = await ctx.operationGate.run(binding.instanceId, 'proxy-write', async () => {
            checkQuota(ctx, binding, header(req, 'x-thinglinks-nonce'), Math.floor(Date.now() / 1000));
            if (!binding.flowRevision) throw new IngressError(409, '旧设备入口尚未校验流程，请在设备入口页面确认当前流程');
            await readBoundRevision(ctx, binding.instanceId, binding.targetPath, binding.deviceId, binding.flowRevision);
            // Rotation/revocation may run while the authenticated snapshot is
            // being read. Recheck before reserving a nonce or forwarding bytes.
            const current = loadBinding(ctx, binding.id);
            if (!current || !current.enabled || current.secretEnc !== binding.secretEnc || current.flowRevision !== binding.flowRevision) {
              throw new IngressError(401, '设备入口凭据或绑定已变更');
            }
            consumeQuota(ctx, binding, header(req, 'x-thinglinks-nonce'), Math.floor(Date.now() / 1000));
            return forward(target, binding, req, reply, body);
          });
          // Node-RED may return attacker-authored HTML. Never render it with the
          // Manager origin's authority; retain bytes/status for device clients.
          return reply.type('text/plain; charset=utf-8').code(result.status).send(result.payload);
        } catch (error) { return fail(reply, error); }
      },
    });
  });
}
