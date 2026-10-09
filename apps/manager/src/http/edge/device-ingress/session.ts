/** Bounded, in-memory Node-RED admin sessions, private to one HTTP context. */
import { createHash } from 'node:crypto';
import type { AdminTarget } from '../../../core/flows/admin-client.ts';
import type { HttpContext } from '../../context.ts';
import { IngressError } from './types.ts';

type Grant = { token: string; refreshAt: number };
type Entry = { scope: string; upstream: string; adminRoot: string; ready: Promise<Grant> };
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class IngressAdminSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private closed = false;

  constructor(options: { capacity?: number; now?: () => number; fetchImpl?: typeof fetch } = {}) {
    this.capacity = options.capacity ?? 128;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 128) throw new Error('session capacity must be 1..128');
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(instanceId: string, target: AdminTarget, credentialVersion: string, signal?: AbortSignal): Promise<string> {
    const scope = createHash('sha256').update(JSON.stringify([
      target.upstream, target.adminRoot, target.username, target.password, credentialVersion,
    ])).digest('hex');
    for (;;) {
      if (this.closed) throw new IngressError(503, '设备入口正在关闭');
      signal?.throwIfAborted();
      const old = this.entries.get(instanceId);
      if (old && old.scope !== scope) { await this.discard(instanceId, old); continue; }
      if (old) {
        const grant = await old.ready;
        if (this.closed || this.entries.get(instanceId) !== old) throw new IngressError(503, '实例管理会话已变更');
        if (grant.refreshAt > this.now()) {
          this.entries.delete(instanceId); this.entries.set(instanceId, old);
          return grant.token;
        }
        await this.discard(instanceId, old); continue;
      }
      if (this.entries.size >= this.capacity) {
        const [id, entry] = this.entries.entries().next().value!;
        await this.discard(id, entry); continue;
      }
      // Reserve a capacity slot before awaiting authentication. Concurrent callers
      // share this promise rather than minting a token for each request.
      const entry: Entry = { scope, upstream: target.upstream, adminRoot: target.adminRoot, ready: this.mint(target, signal) };
      this.entries.set(instanceId, entry);
      try {
        const grant = await entry.ready;
        if (this.closed || this.entries.get(instanceId) !== entry) throw new IngressError(503, '实例管理会话已变更');
        return grant.token;
      } catch (error) {
        if (this.entries.get(instanceId) === entry) this.entries.delete(instanceId);
        throw error;
      }
    }
  }

  async invalidate(instanceId: string, token: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    const grant = await entry.ready.catch(() => undefined);
    if (grant?.token === token) await this.discard(instanceId, entry);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries].map(([id, entry]) => this.discard(id, entry)));
  }

  private async discard(instanceId: string, entry: Entry): Promise<void> {
    if (this.entries.get(instanceId) !== entry) return;
    this.entries.delete(instanceId);
    // Replaced, expired, evicted and shutdown sessions all get an explicit best
    // effort revocation. The request has a separate 1 s deadline and no redirect.
    try {
      const grant = await entry.ready;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await this.fetchImpl(`${entry.upstream}${entry.adminRoot}auth/revoke`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ token: grant.token }),
        });
        await response.body?.cancel();
      } finally { clearTimeout(timer); controller.abort(); }
    } catch { /* Best effort only: failed revocation never restores an invalid cache entry. */ }
  }

  private async mint(target: AdminTarget, signal?: AbortSignal): Promise<Grant> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const issuedAt = this.now();
    try {
      const response = await this.fetchImpl(`${target.upstream}${target.adminRoot}auth/token`, {
        method: 'POST', redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'node-red-editor', grant_type: 'password', scope: '*', username: target.username, password: target.password }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('authentication failed'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty token response');
      const parts: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 32768) { await reader.cancel(); throw new Error('token response too large'); }
          parts.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8')) as { access_token?: unknown; expires_in?: unknown };
      if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || /\s/.test(value.access_token)
        || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in < 1) throw new Error('invalid token response');
      const ttl = Math.min(value.expires_in * 1000, MAX_TTL_MS);
      // Honour native expires_in with an early margin, capped at seven days.
      return { token: value.access_token, refreshAt: issuedAt + ttl - Math.min(30000, ttl * 0.1) };
    } catch { throw new IngressError(502, '无法建立实例管理会话'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}

const contexts = new WeakMap<HttpContext, IngressAdminSessions>();
export function ingressSessions(ctx: HttpContext): IngressAdminSessions {
  let sessions = contexts.get(ctx);
  if (!sessions) { sessions = new IngressAdminSessions(); contexts.set(ctx, sessions); }
  return sessions;
}
export async function closeIngressSessions(ctx: HttpContext): Promise<void> {
  const sessions = contexts.get(ctx);
  contexts.delete(ctx);
  await sessions?.close();
}
