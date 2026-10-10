import { DEVICE_ID_PATTERN } from '../../../core/edge/device-identity.ts';
/** Fixed-path validation and byte-exact device HMAC authentication. */
import type { FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decryptSecret } from '../../../core/auth/crypto.ts';
import type { HttpContext } from '../../context.ts';
import { IngressError, type HttpDeviceBinding as Binding } from './types.ts';

export const DEFAULT_MAX_BODY = 1024 * 1024;
export const MAX_BODY = 8 * 1024 * 1024;
export const DEFAULT_RATE = 60;
export const MAX_RATE = 6000;
export const CLOCK_SKEW_SECONDS = 300;
export const NONCE_TTL_SECONDS = CLOCK_SKEW_SECONDS * 2 + 1;
export const RESPONSE_LIMIT = 1024 * 1024;
export const FORWARD_TIMEOUT_MS = 5000;
export const MAX_CONCURRENT_REQUESTS = 16;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;


export function pathValue(value: unknown, field: string): string {
  // Never normalize attacker input into an allowed path. Encoded separators,
  // dots and double encoding are rejected before URL/Express can interpret them.
  if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9._~/-]+$/.test(value)
    || value.includes('//') || value.split('/').some(part => part === '.' || part === '..')) {
    throw new IngressError(400, `${field} 必须是固定的绝对路径`);
  }
  return value;
}

export function instanceDevicePath(instance: { adminRoot: string }, path: string): boolean {
  const root = `${instance.adminRoot.replace(/\/$/, '')}/api/`;
  return path === root.slice(0, -1) || path.startsWith(root);
}

export function textValue(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string') throw new IngressError(400, `${field} 必须是文本`);
  const text = value.trim();
  if (!text || text.length > max || !ID_RE.test(text)) throw new IngressError(400, `${field} 无效`);
  return text;
}

export function deviceIdentity(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value.trim())) throw new IngressError(400, '设备标识需符合模板格式，最多 128 个字符');
  return value.trim();
}

export function numberValue(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new IngressError(400, `${field} 必须是 ${min}-${max} 的整数`);
  return value;
}

export function header(req: FastifyRequest, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '').trim();
}

export function signaturePayload(req: FastifyRequest, binding: Binding, timestamp: string, nonce: string, body: Buffer): string {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const digest = createHash('sha256').update(body).digest('hex');
  return [req.method.toUpperCase(), path, binding.id, binding.deviceId, timestamp, nonce, digest].join('\n');
}

export function constantTimeHex(expected: string, presented: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(presented)) return false;
  const actual = Buffer.from(presented, 'hex');
  const want = Buffer.from(expected, 'hex');
  return actual.length === want.length && timingSafeEqual(actual, want);
}

export function requestSecret(ctx: HttpContext, binding: Binding): string {
  try { return decryptSecret(binding.secretEnc, ctx.repo.key); }
  catch { throw new IngressError(500, '设备入口凭据无法解密'); }
}

export function verifyDeviceRequest(ctx: HttpContext, binding: Binding, req: FastifyRequest, body: Buffer): void {
  const timestamp = header(req, 'x-thinglinks-timestamp');
  const nonce = header(req, 'x-thinglinks-nonce');
  const signature = header(req, 'x-thinglinks-signature');
  if (!/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[0-9a-f]{64}$/i.test(signature)) {
    throw new IngressError(401, '设备入口签名头不完整');
  }
  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > CLOCK_SKEW_SECONDS) {
    throw new IngressError(401, '设备入口签名已过期');
  }
  const expected = createHmac('sha256', requestSecret(ctx, binding))
    .update(signaturePayload(req, binding, timestamp, nonce, body)).digest('hex');
  if (!constantTimeHex(expected, signature)) throw new IngressError(401, '设备入口签名无效');
}
