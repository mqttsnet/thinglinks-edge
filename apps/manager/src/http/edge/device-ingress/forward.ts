/** Bounded, non-redirecting transport to one verified instance HTTP path. */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { HttpContext } from '../../context.ts';
import { IngressError, type HttpDeviceBinding as Binding } from './types.ts';
import { RESPONSE_LIMIT, FORWARD_TIMEOUT_MS, pathValue, instanceDevicePath } from './protocol.ts';

export async function readResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.length;
      if (total > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new IngressError(502, '设备入口上游响应过大');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function verifyTarget(ctx: HttpContext, binding: Binding): URL {
  const instance = ctx.repo.get(binding.instanceId);
  if (!instance) throw new IngressError(404, '实例不存在');
  const path = pathValue(binding.targetPath, 'targetPath');
  if (!instanceDevicePath(instance, path)) throw new IngressError(400, 'targetPath 必须位于该实例的 httpNodeRoot 下');
  let upstream: URL;
  try {
    upstream = new URL(ctx.upstreamFor(binding.instanceId));
  } catch { throw new IngressError(502, '实例上游地址无效'); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.search || upstream.hash || upstream.pathname !== '/') throw new IngressError(502, '实例上游地址无效');
  const target = new URL(path, upstream.origin);
  if (target.origin !== upstream.origin || target.pathname !== path) throw new IngressError(400, '设备入口路径无效');
  return target;
}

export async function forward(target: URL, binding: Binding, req: FastifyRequest, reply: FastifyReply, body: Buffer): Promise<{ status: number; payload: Buffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  const abort = () => controller.abort();
  req.raw.once('aborted', abort);
  reply.raw.once('close', abort);
  try {
    const requestInit: RequestInit = {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-thinglinks-device-id': binding.deviceId,
        'x-thinglinks-instance-id': binding.instanceId,
      },
      signal: controller.signal,
      redirect: 'manual',
    };
    if (body.length > 0) requestInit.body = body;
    const forwarded = await fetch(target, requestInit);
    if (forwarded.status >= 300 && forwarded.status < 400) {
      await forwarded.body?.cancel();
      throw new IngressError(502, '设备入口不允许上游重定向');
    }
    const payload = await readResponse(forwarded);
    return { status: forwarded.status, payload };
  } catch (error) {
    if (error instanceof IngressError) throw error;
    if ((error as Error).name === 'AbortError') throw new IngressError(504, '设备入口上游响应超时');
    throw new IngressError(502, '设备入口无法连接实例流程');
  } finally { clearTimeout(timer); req.raw.off('aborted', abort); reply.raw.off('close', abort); }
}
