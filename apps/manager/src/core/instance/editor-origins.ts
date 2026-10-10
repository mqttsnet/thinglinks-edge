import { randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

export interface EditorOriginOptions {
  externalUrl: string;
  basePath: string;
  portRange?: { min: number; max: number };
  allowedMainOrigins?: string[];
  /** Stable, non-secret digest of the instance generation; missing means deleted. */
  generationFor(instanceId: string): string | undefined;
  now?: () => number;
}

export interface EditorHandoffIdentity {
  sessionId: string;
  username: string;
  instanceId: string;
  scope: 'read' | '*';
}

export interface EditorHandoffPayload {
  token: { access_token: string; token_type: 'Bearer'; scope: 'read' | '*'; expires_in?: number };
  storageKey: string;
  adminRoot: string;
}

export interface EditorHandoffInput extends EditorHandoffIdentity, EditorHandoffPayload { mainOrigin?: string }
interface PendingHandoff {
  identity: EditorHandoffIdentity;
  payload: EditorHandoffPayload;
  generation: string;
  expiresAt: number;
  stillAuthorized(): boolean;
}

/** Every instance generation has a distinct browser origin, independent of Manager credentials. */
export class EditorOrigins {
  readonly portRange: { min: number; max: number };
  readonly #db: Db;
  readonly #options: EditorOriginOptions;
  readonly #mainOrigins: Set<string>;
  readonly #pending = new Map<string, PendingHandoff>();

  constructor(db: Db, options: EditorOriginOptions) {
    this.#db = db;
    this.#options = options;
    this.portRange = { ...(options.portRange ?? { min: 19200, max: 19263 }) };
    const { min, max } = this.portRange;
    const external = new URL(options.externalUrl);
    this.#mainOrigins = new Set([external.origin, ...(options.allowedMainOrigins ?? [])]);
    if (!['http:', 'https:'].includes(external.protocol)
      || !Number.isInteger(min) || !Number.isInteger(max) || min < 1024 || max > 65535 || min > max || max - min > 1023
      || [...this.#mainOrigins].some((origin) => {
        const url = new URL(origin);
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || (port >= min && port <= max);
      })) throw new Error('编辑器独立端口范围无效或与管理端口冲突');
  }

  #now(): number { return (this.#options.now ?? Date.now)(); }

  #generation(id: string): string {
    const generation = this.#options.generationFor(id);
    if (!generation) throw new Error('实例不存在，无法分配编辑器端口');
    return generation;
  }

  portFor(id: string): number {
    const generation = this.#generation(id);
    return this.#db.transaction(() => {
      const existing = this.#db.prepare('SELECT port FROM editor_origin WHERE instance_id = ? AND generation = ?')
        .get(id, generation) as { port: number } | undefined;
      if (existing) {
        if (existing.port < this.portRange.min || existing.port > this.portRange.max) throw new Error('实例编辑器端口已不在当前监听范围，请恢复或扩大端口范围');
        return existing.port;
      }
      const used = new Set((this.#db.prepare('SELECT port FROM editor_origin').all() as Array<{ port: number }>).map((row) => row.port));
      for (let port = this.portRange.min; port <= this.portRange.max; port++) {
        if (used.has(port)) continue;
        this.#db.prepare('INSERT INTO editor_origin (instance_id, generation, port) VALUES (?, ?, ?)').run(id, generation, port);
        return port;
      }
      throw new Error('编辑器独立端口已用完，请扩大端口范围；为隔离历史浏览器存储，旧端口不会自动复用');
    })();
  }

  runtimeInstance(port: number): string | undefined {
    if (port < this.portRange.min || port > this.portRange.max) return undefined;
    const row = this.#db.prepare('SELECT instance_id, generation FROM editor_origin WHERE port = ?').get(port) as
      { instance_id: string; generation: string } | undefined;
    return row && this.#options.generationFor(row.instance_id) === row.generation ? row.instance_id : undefined;
  }

  origin(id: string, mainOrigin?: string): string {
    const canonical = mainOrigin ?? new URL(this.#options.externalUrl).origin;
    if (!this.#mainOrigins.has(canonical)) throw new Error('编辑器入口 Origin 不被允许');
    const url = new URL(canonical);
    url.port = String(this.portFor(id));
    return url.origin;
  }

  matchesOrigin(id: string, origin: string | undefined): boolean {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      return origin === url.origin && this.runtimeInstance(port) === id
        && [...this.#mainOrigins].some((main) => {
          const candidate = new URL(main); candidate.port = String(port);
          return candidate.origin === origin;
        });
    } catch { return false; }
  }

  matchesHost(id: string, host: string | undefined, port: number): boolean {
    if (!host || this.runtimeInstance(port) !== id) return false;
    return [...this.#mainOrigins].some((main) => {
      const url = new URL(main); url.port = String(port);
      return url.host === host.toLowerCase();
    });
  }

  issueHandoff(input: EditorHandoffInput, stillAuthorized: () => boolean): { editorUrl: string } {
    const now = this.#now();
    for (const [key, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(key);
    if (!input.sessionId || !input.username || !stillAuthorized()) throw new Error('编辑器授权已失效，请重新验证');
    if (input.adminRoot !== `${this.#options.basePath}/red/${input.instanceId}/`) throw new Error('编辑器路径无效');
    if (this.#pending.size >= 1024) throw new Error('编辑器登录交接繁忙，请稍后重试');
    const origin = this.origin(input.instanceId, input.mainOrigin);
    const ticket = randomBytes(32).toString('base64url');
    const { sessionId, username, instanceId, scope, token, storageKey, adminRoot } = input;
    this.#pending.set(ticket, { identity: { sessionId, username, instanceId, scope },
      payload: { token: { ...token }, storageKey, adminRoot }, generation: this.#generation(instanceId),
      expiresAt: now + 60_000, stillAuthorized });
    return { editorUrl: `${origin}${adminRoot}editor-entry#${ticket}` };
  }

  consumeHandoff(ticket: string, identity: EditorHandoffIdentity): EditorHandoffPayload | undefined {
    const pending = this.#pending.get(ticket);
    this.#pending.delete(ticket);
    if (!pending || pending.expiresAt <= this.#now()
      || pending.generation !== this.#options.generationFor(identity.instanceId)
      || pending.identity.sessionId !== identity.sessionId || pending.identity.username !== identity.username
      || pending.identity.instanceId !== identity.instanceId || pending.identity.scope !== identity.scope) return undefined;
    try { return pending.stillAuthorized() ? pending.payload : undefined; } catch { return undefined; }
  }

  revokeUser(username: string, instanceId?: string): void {
    for (const [ticket, pending] of this.#pending) if (pending.identity.username === username
      && (instanceId === undefined || pending.identity.instanceId === instanceId)) this.#pending.delete(ticket);
  }

  revokeSession(sessionId: string, instanceId?: string): void {
    for (const [ticket, pending] of this.#pending) if (pending.identity.sessionId === sessionId
      && (instanceId === undefined || pending.identity.instanceId === instanceId)) this.#pending.delete(ticket);
  }
}
