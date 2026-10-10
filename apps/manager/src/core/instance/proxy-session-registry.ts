export interface ProxyWebSocketSession {
  close(code: number): void;
  /** Revocation must not wait for a cooperative peer's close handshake. */
  terminate?(): void;
}

export interface ProxySessionIdentity {
  username: string;
  sessionId: string;
  instanceId: string;
}

export interface ProxySessionAuthorization {
  register(session: ProxyWebSocketSession): (() => void) | undefined;
  release(): void;
}

export type ProxySessionRevocation =
  | { username: string; instanceId?: string }
  | { sessionId: string; instanceId?: string };

interface TrackedAuthorization {
  identity: ProxySessionIdentity;
  valid(): boolean;
  revoke(): void;
}

function rejectSession(session: ProxyWebSocketSession): void {
  try { session.close(1008); } catch { /* An already closed socket must not interrupt revocation. */ }
  try { session.terminate?.(); } catch { /* Continue revoking the other affected sessions. */ }
}

export interface ProxySessionDrainOptions {
  code: number;
  timeoutMs: number;
}

export class ProxySessionDrainTimeoutError extends Error {
  readonly instanceId: string;
  readonly remaining: number;

  constructor(instanceId: string, remaining: number, timeoutMs: number) {
    super(
      `实例 ${instanceId} 的 ${remaining} 个 WebSocket 会话在 ${timeoutMs}ms 内未关闭`,
    );
    this.name = 'ProxySessionDrainTimeoutError';
    this.instanceId = instanceId;
    this.remaining = remaining;
  }
}

/**
 * Core-only port for active reverse-proxy WebSocket sessions.
 *
 * The HTTP adapter registers source WebSockets and unregisters them from its
 * disconnect hook. Migration code sees only this port, so core code never
 * depends on Fastify, ws, or Node's HTTP types.
 */
export class ProxySessionRegistry {
  private readonly sessions = new Map<
    string,
    Map<ProxyWebSocketSession, symbol>
  >();
  private readonly drained = new Map<string, Set<() => void>>();
  private readonly authorizations = new Set<TrackedAuthorization>();
  private readonly authorizationCheckMs: number;
  private authorizationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly revocationListeners = new Set<(target: ProxySessionRevocation) => void>();

  constructor(options: { authorizationCheckMs?: number } = {}) {
    this.authorizationCheckMs = options.authorizationCheckMs ?? 5_000;
    if (!Number.isFinite(this.authorizationCheckMs) || this.authorizationCheckMs <= 0) {
      throw new RangeError('WebSocket authorizationCheckMs must be a positive number');
    }
  }

  /**
   * Register the authorization before the asynchronous upgrade starts. Revoking
   * a grant invalidates pending tickets too, even if that grant is later restored.
   * The validator must check the current session without refreshing its idle TTL.
   */
  authorize(identity: ProxySessionIdentity, validate: () => boolean): ProxySessionAuthorization {
    let live = true;
    let source: ProxyWebSocketSession | undefined;
    let unregister: (() => void) | undefined;
    const release = () => {
      live = false;
      this.authorizations.delete(tracked);
      unregister?.();
      unregister = undefined;
      if (this.authorizations.size === 0 && this.authorizationTimer) {
        clearInterval(this.authorizationTimer);
        this.authorizationTimer = undefined;
      }
    };
    const tracked: TrackedAuthorization = {
      identity: { ...identity },
      valid: () => {
        if (!live) return false;
        try { return validate() === true; } catch { return false; }
      },
      revoke: () => {
        const active = source;
        release();
        if (active) rejectSession(active);
      },
    };
    // Bound both pending handshakes and active sessions. Reject excess channels
    // instead of evicting a previously admitted user's authorization.
    if (this.authorizations.size >= 4096 || !tracked.valid()) live = false;
    else {
      this.authorizations.add(tracked);
      this.authorizationTimer ??= setInterval(() => this.revalidate(), this.authorizationCheckMs);
      this.authorizationTimer.unref();
    }
    return {
      register: (session) => {
        if (source === session && tracked.valid()) return release;
        if (source || !tracked.valid()) {
          tracked.revoke();
          rejectSession(session);
          return undefined;
        }
        source = session;
        unregister = this.register(identity.instanceId, session);
        return release;
      },
      release,
    };
  }

  closeUser(username: string, instanceId?: string): void {
    for (const tracked of [...this.authorizations]) {
      if (tracked.identity.username === username
          && (instanceId === undefined || tracked.identity.instanceId === instanceId)) tracked.revoke();
    }
    this.notifyRevocation({ username, ...(instanceId === undefined ? {} : { instanceId }) });
  }

  closeSession(sessionId: string | undefined, instanceId?: string): void {
    if (!sessionId) return;
    for (const tracked of [...this.authorizations]) {
      if (tracked.identity.sessionId === sessionId
          && (instanceId === undefined || tracked.identity.instanceId === instanceId)) tracked.revoke();
    }
    this.notifyRevocation({ sessionId, ...(instanceId === undefined ? {} : { instanceId }) });
  }

  /** Related session capabilities (such as editor unlocks) share the same revocation boundary. */
  onRevoked(listener: (target: ProxySessionRevocation) => void): () => void {
    this.revocationListeners.add(listener);
    return () => { this.revocationListeners.delete(listener); };
  }

  private notifyRevocation(target: ProxySessionRevocation): void {
    for (const listener of this.revocationListeners) listener(target);
  }

  /** Also covers expiry and policy changes originating outside the user routes. */
  revalidate(): void {
    for (const tracked of [...this.authorizations]) {
      if (!tracked.valid()) {
        tracked.revoke();
        this.notifyRevocation({ sessionId: tracked.identity.sessionId, instanceId: tracked.identity.instanceId });
      }
    }
  }

  register(instanceId: string, session: ProxyWebSocketSession): () => void {
    const active = this.sessions.get(instanceId) ?? new Map<ProxyWebSocketSession, symbol>();
    const token = active.get(session) ?? Symbol('proxy-session-registration');
    active.set(session, token);
    this.sessions.set(instanceId, active);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = this.sessions.get(instanceId);
      if (current?.get(session) !== token) return;
      current.delete(session);
      if (current && current.size === 0) {
        this.sessions.delete(instanceId);
        const waiters = this.drained.get(instanceId);
        this.drained.delete(instanceId);
        for (const resolve of waiters ?? []) resolve();
      }
    };
  }

  count(instanceId: string): number {
    return this.sessions.get(instanceId)?.size ?? 0;
  }

  async closeAndDrain(
    instanceId: string,
    options: ProxySessionDrainOptions,
  ): Promise<void> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new RangeError('WebSocket drain timeoutMs must be a non-negative number');
    }

    const snapshot = [...(this.sessions.get(instanceId)?.keys() ?? [])];
    for (const session of snapshot) session.close(options.code);
    if (this.count(instanceId) === 0) return;

    await new Promise<void>((resolve, reject) => {
      const waiters = this.drained.get(instanceId) ?? new Set<() => void>();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.drained.delete(instanceId);
        resolve();
      };
      waiters.add(done);
      this.drained.set(instanceId, waiters);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(done);
        if (waiters.size === 0) this.drained.delete(instanceId);
        reject(new ProxySessionDrainTimeoutError(
          instanceId,
          this.count(instanceId),
          options.timeoutMs,
        ));
      }, options.timeoutMs);
    });
  }
}
