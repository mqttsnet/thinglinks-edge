/** Durable binding projections, nonce replay fences and request quotas. */
import type { HttpContext } from '../../context.ts';
import { IngressError, type HttpDeviceBinding as Binding } from './types.ts';
import { NONCE_TTL_SECONDS } from './protocol.ts';

export function bindingRow(row: Record<string, unknown>): Binding {
  return {
    id: row['id'] as string,
    instanceId: row['instance_id'] as string,
    targetPath: row['target_path'] as string,
    deviceId: row['device_id'] as string,
    secretEnc: row['secret_enc'] as string,
    enabled: row['enabled'] === 1,
    maxBodyBytes: row['max_body_bytes'] as number,
    rateLimitPerMinute: row['rate_limit_per_minute'] as number,
    flowRevision: row['flow_revision'] as string,
  };
}

export function bindingPublic(row: Binding) {
  return {
    id: row.id,
    instanceId: row.instanceId,
    targetPath: row.targetPath,
    deviceId: row.deviceId,
    enabled: row.enabled,
    maxBodyBytes: row.maxBodyBytes,
    rateLimitPerMinute: row.rateLimitPerMinute,
    requiresRebind: row.flowRevision === '',
  };
}

export function loadBinding(ctx: HttpContext, id: string): Binding | undefined {
  const row = ctx.db.prepare('SELECT * FROM device_http_binding WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? bindingRow(row) : undefined;
}

/** Cheap read-only rejection before native Admin API work; consume still rechecks atomically. */
export function checkQuota(ctx: HttpContext, binding: Binding, nonce: string, now: number): void {
  if (ctx.db.prepare('SELECT 1 FROM device_http_nonce WHERE binding_id=? AND nonce=? AND expires_at>?').get(binding.id, nonce, now)) {
    throw new IngressError(409, '请求 nonce 已使用');
  }
  const windowStart = Math.floor(now / 60) * 60;
  const row = ctx.db.prepare('SELECT request_count FROM device_http_rate WHERE binding_id=? AND window_start=?')
    .get(binding.id, windowStart) as { request_count: number } | undefined;
  if (row && row.request_count >= binding.rateLimitPerMinute) {
    throw new IngressError(429, '设备入口请求过于频繁', { 'retry-after': String(60 - (now % 60)) });
  }
}

export function consumeQuota(ctx: HttpContext, binding: Binding, nonce: string, now: number): void {
  try {
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM device_http_nonce WHERE expires_at <= ?').run(now);
      const existing = ctx.db.prepare(
        'SELECT 1 FROM device_http_nonce WHERE binding_id = ? AND nonce = ?',
      ).get(binding.id, nonce);
      if (existing) throw new IngressError(409, '请求 nonce 已使用');

      const windowStart = Math.floor(now / 60) * 60;
      const rate = ctx.db.prepare(
        'SELECT window_start, request_count FROM device_http_rate WHERE binding_id = ?',
      ).get(binding.id) as { window_start: number; request_count: number } | undefined;
      const count = rate && rate.window_start === windowStart ? rate.request_count : 0;
      if (count >= binding.rateLimitPerMinute) {
        throw new IngressError(429, '设备入口请求过于频繁', { 'retry-after': String(60 - (now % 60)) });
      }
      if (rate) {
        ctx.db.prepare(
          'UPDATE device_http_rate SET window_start = ?, request_count = ? WHERE binding_id = ?',
        ).run(windowStart, count + 1, binding.id);
      } else {
        ctx.db.prepare(
          'INSERT INTO device_http_rate(binding_id, window_start, request_count) VALUES (?, ?, ?)',
        ).run(binding.id, windowStart, 1);
      }
      ctx.db.prepare(
        'INSERT INTO device_http_nonce(binding_id, nonce, expires_at) VALUES (?, ?, ?)',
      ).run(binding.id, nonce, now + NONCE_TTL_SECONDS);
    })();
  } catch (error) {
    if (error instanceof IngressError) throw error;
    // SQLite's primary-key race has the same externally safe meaning as a replay.
    if (String((error as Error).message).includes('UNIQUE constraint')) throw new IngressError(409, '请求 nonce 已使用');
    throw error;
  }
}
