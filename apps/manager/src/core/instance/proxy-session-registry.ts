export interface ProxyWebSocketSession {
  close(code: number): void;
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
