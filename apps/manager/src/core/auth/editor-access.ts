import { createHmac, randomBytes } from 'node:crypto';

export interface EditorIdentity {
  sessionId: string;
  username: string;
  instanceId: string;
  scope: 'read' | '*';
}
export interface EditorLease extends EditorIdentity { expiresAt: number }
interface StoredLease extends EditorLease { credentialVersion: string }
interface AttemptBucket { count: number; expiresAt: number; credentialVersion: string }
interface Options {
  credentialFor: (id: string) => { username: string; password: string; revision?: string } | undefined;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

/** In-memory second gate: an instance token alone never unlocks the Manager proxy. */
export class EditorAccessStore {
  readonly #leases = new Map<string, StoredLease>();
  readonly #attempts = new Map<string, AttemptBucket>();
  readonly #pepper = randomBytes(32);
  readonly #options: Options;
  #generation = 0;
  constructor(options: Options) { this.#options = options; }
  get generation(): number { return this.#generation; }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #key(sessionId: string, instanceId: string): string { return JSON.stringify([sessionId, instanceId]); }
  #prune(): void {
    const now = this.#now();
    for (const [key, lease] of this.#leases) if (lease.expiresAt <= now) this.#leases.delete(key);
    for (const [key, bucket] of this.#attempts) if (bucket.expiresAt <= now) this.#attempts.delete(key);
  }
  credentialVersion(instanceId: string): string | undefined {
    const credential = this.#options.credentialFor(instanceId);
    return credential && createHmac('sha256', this.#pepper)
      .update(JSON.stringify([credential.username, credential.password, credential.revision])).digest('hex');
  }
  grant(identity: EditorIdentity, expected?: { credentialVersion: string; generation: number }): EditorLease {
    this.#prune();
    const credentialVersion = this.credentialVersion(identity.instanceId);
    if (!identity.sessionId || !credentialVersion || (expected && (expected.generation !== this.#generation || expected.credentialVersion !== credentialVersion))) {
      throw new Error('编辑器授权状态已变化，请重新验证');
    }
    const key = this.#key(identity.sessionId, identity.instanceId);
    if (!this.#leases.has(key) && this.#leases.size >= (this.#options.maxEntries ?? 10_000)) throw new Error('编辑器授权容量已满，请稍后重试');
    const lease = { ...identity, expiresAt: this.#now() + (this.#options.ttlMs ?? 30 * 60_000) };
    this.#leases.set(key, { ...lease, credentialVersion });
    this.#attempts.delete(this.#key(identity.username, identity.instanceId));
    return lease;
  }
  check(identity: EditorIdentity): EditorLease | undefined {
    const key = this.#key(identity.sessionId, identity.instanceId);
    const lease = this.#leases.get(key);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.#now() || lease.username !== identity.username || lease.scope !== identity.scope
      || lease.credentialVersion !== this.credentialVersion(identity.instanceId)) {
      this.#leases.delete(key);
      return undefined;
    }
    const { credentialVersion: _version, ...result } = lease;
    return result;
  }
  attempt(username: string, instanceId: string): { allowed: boolean; retryAfterSeconds: number } {
    this.#prune();
    // A fresh Manager login must not buy another set of guesses. Keep attempts
    // per account/instance, while editor leases remain session-specific.
    const key = this.#key(username, instanceId);
    let bucket = this.#attempts.get(key);
    const credentialVersion = this.credentialVersion(instanceId);
    if (!username || !credentialVersion || (!bucket && this.#attempts.size >= (this.#options.maxEntries ?? 10_000))) return { allowed: false, retryAfterSeconds: 300 };
    // Administrative credential rotation starts a new window for the new secret.
    // Logout/revocation alone never clears this bucket or another user's bucket.
    if (!bucket || bucket.credentialVersion !== credentialVersion) {
      bucket = { count: 0, expiresAt: this.#now() + 300_000, credentialVersion };
      this.#attempts.set(key, bucket);
    }
    if (bucket.count >= 5) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - this.#now()) / 1000)) };
    bucket.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  }
  revokeUser(username: string, instanceId?: string): void {
    this.#generation++;
    for (const [key, lease] of this.#leases) if (lease.username === username && (instanceId === undefined || lease.instanceId === instanceId)) this.#leases.delete(key);
  }
  revokeSession(sessionId: string, instanceId?: string): void {
    this.#generation++;
    for (const [key, lease] of this.#leases) if (lease.sessionId === sessionId && (instanceId === undefined || lease.instanceId === instanceId)) this.#leases.delete(key);
  }
}
