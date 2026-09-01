/**
 * Core-side port for addressing and waiting on one Node-RED Admin API.
 * Credentials are resolved only from InstanceRepo and never logged or persisted elsewhere.
 */
import { getAccessToken, type AdminTarget, type FetchLike } from '../flows/admin-client.ts';
import type { InstanceRepo } from './repo.ts';

export interface InstanceAdminRuntime {
  target(instanceId: string): AdminTarget;
  waitReady(
    instanceId: string,
    options: { timeoutMs: number; intervalMs: number },
  ): Promise<void>;
}

export type InstanceAdminRuntimeErrorReason =
  | 'instance-not-found'
  | 'credential-not-found'
  | 'readiness-timeout';

export class InstanceAdminRuntimeError extends Error {
  readonly reason: InstanceAdminRuntimeErrorReason;

  constructor(reason: InstanceAdminRuntimeErrorReason, message: string) {
    super(message);
    this.name = 'InstanceAdminRuntimeError';
    this.reason = reason;
  }
}

export interface RepositoryInstanceAdminRuntimeOptions {
  repo: InstanceRepo;
  upstreamFor: (instanceId: string) => string;
  fetchImpl?: FetchLike | undefined;
}

export class RepositoryInstanceAdminRuntime implements InstanceAdminRuntime {
  private readonly options: RepositoryInstanceAdminRuntimeOptions;

  constructor(options: RepositoryInstanceAdminRuntimeOptions) {
    this.options = options;
  }

  target(instanceId: string): AdminTarget {
    const instance = this.options.repo.get(instanceId);
    if (!instance) {
      throw new InstanceAdminRuntimeError('instance-not-found', `实例 ${instanceId} 不存在`);
    }
    const credential = this.options.repo.credentials(instanceId)[0];
    if (!credential) {
      throw new InstanceAdminRuntimeError('credential-not-found', `实例 ${instanceId} 无可用账号`);
    }
    return {
      upstream: this.options.upstreamFor(instanceId),
      adminRoot: instance.adminRoot,
      username: credential.username,
      password: credential.password,
    };
  }

  async waitReady(
    instanceId: string,
    options: { timeoutMs: number; intervalMs: number },
  ): Promise<void> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError('timeoutMs 必须是正数');
    }
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new TypeError('intervalMs 必须是正数');
    }
    const target = this.target(instanceId);
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await getAccessToken(target, this.options.fetchImpl ?? fetch, remaining);
        return;
      } catch {
        const delay = Math.min(options.intervalMs, Math.max(0, deadline - Date.now()));
        if (delay <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new InstanceAdminRuntimeError(
      'readiness-timeout',
      `实例 ${instanceId} 的 Admin API 未在 ${options.timeoutMs}ms 内就绪`,
    );
  }
}
