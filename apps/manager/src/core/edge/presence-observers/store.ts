import { randomBytes } from 'node:crypto';
import type { Db } from '../../db.ts';
import {
  PresenceObserverError, assertObserverCounter, assertObserverId,
  type ObserverScope, type ObserverEvent, type ObserverAggregate, type ObserverAcceptance,
  type ObserverActivation, type ObserverChallenge,
} from './types.ts';

interface ObserverRow {
  instance_id: string; node_id: string; observer_id: string; revision: number;
  current_run: string | null; last_sequence: number; state: 'online' | 'offline' | 'unknown';
  lifecycle: 'active' | 'stopped' | 'retired'; lease_expires_at: number;
}
interface RunRow {
  run_nonce: string; expected_revision: number; ticket: string; ticket_expires_at: number;
  activated_generation: number | null; previous_generation: number | null;
}
interface Options {
  now?: () => number; maxDevices?: number; maxObservers?: number; maxRuns?: number;
  ticketTtlMs?: number; leaseDurationMs?: number;
  maxDevicesPerInstance?: number; maxObserversPerInstance?: number; maxRunsPerInstance?: number;
}
const conflict = () => new PresenceObserverError('OBSERVER_RUN_CONFLICT', '采集运行代次已被替换，请检查是否重复部署；旧运行不会重新抢占');
function identity(scope: ObserverScope): [string, string, string] {
  assertObserverId(scope.instanceId); assertObserverId(scope.nodeId); assertObserverId(scope.observerId);
  return [scope.instanceId, scope.nodeId, scope.observerId];
}
function next(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new PresenceObserverError('OBSERVER_SEQUENCE_EXHAUSTED', '采集观察序列已达到上限，请更换运行代次');
  return value + 1;
}

/** All writes are synchronous SQLite transactions; the same aggregate feeds local state and Cloud sync. */
export class PresenceObservers {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly limits: Required<Omit<Options, 'now'>>;
  private readonly activity = new Map<string, number>();
  constructor(db: Db, options: Options = {}) {
    this.db = db; this.now = options.now ?? Date.now;
    this.limits = { maxDevices: options.maxDevices ?? 10000, maxObservers: options.maxObservers ?? 10000,
      maxRuns: options.maxRuns ?? 50000, ticketTtlMs: options.ticketTtlMs ?? 30000,
      leaseDurationMs: options.leaseDurationMs ?? 60000,
      maxDevicesPerInstance: options.maxDevicesPerInstance ?? 512,
      maxObserversPerInstance: options.maxObserversPerInstance ?? 1024,
      maxRunsPerInstance: options.maxRunsPerInstance ?? 4096 };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid presence observer limit');
    }
  }

  /** Shared Manager singleton fence for an asynchronous Docker snapshot; never used to order device events. */
  activityVersion(instanceId: string): number { return this.activity.get(instanceId) ?? 0; }
  private recordActivity(instanceId: string): void {
    const current = this.activityVersion(instanceId);
    this.activity.set(instanceId, current === Number.MAX_SAFE_INTEGER ? 0 : current + 1);
  }

  private observer(scope: ObserverScope): ObserverRow | undefined {
    return this.db.prepare('SELECT * FROM presence_observer WHERE instance_id=? AND node_id=? AND observer_id=?')
      .get(...identity(scope)) as ObserverRow | undefined;
  }
  private run(scope: ObserverScope, nonce: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM presence_observer_run WHERE instance_id=? AND node_id=? AND observer_id=? AND run_nonce=?')
      .get(...identity(scope), nonce) as RunRow | undefined;
  }
  private count(table: 'presence_observer_device' | 'presence_observer' | 'presence_observer_run', instanceId?: string): number {
    const row = instanceId === undefined
      ? this.db.prepare(`SELECT count(*) n FROM ${table}`).get()
      : this.db.prepare(`SELECT count(*) n FROM ${table} WHERE instance_id=?`).get(instanceId);
    return (row as { n: number }).n;
  }
  private capacity(scope: ObserverScope, instanceOnly = false): PresenceObserverError {
    this.db.prepare('UPDATE presence_observer_device SET blocked_unknown=1 WHERE instance_id=? AND node_id=?').run(scope.instanceId, scope.nodeId);
    return new PresenceObserverError('OBSERVER_CAPACITY', `${instanceOnly ? '本实例的' : ''}采集观察来源达到上限，未知来源将阻止自动离线；请核对观察者配置`, 409);
  }
  private activation(row: ObserverRow): ObserverActivation {
    return { observerId: row.observer_id, runNonce: row.current_run!, generation: row.revision,
      nextSequence: next(row.last_sequence), leaseExpiresAt: row.lease_expires_at };
  }

  challenge(scope: ObserverScope, runNonce: string): ObserverChallenge {
    const key = identity(scope); assertObserverId(runNonce);
    const result = this.db.transaction((): ObserverChallenge | PresenceObserverError => {
      if (!this.db.prepare('SELECT 1 FROM instance WHERE id=?').get(scope.instanceId)) {
        return new PresenceObserverError('OBSERVER_INSTANCE_MISSING', '采集实例不存在', 404);
      }
      if (!this.hasObservers(scope.instanceId, scope.nodeId)) {
        if (this.count('presence_observer_device', scope.instanceId) >= this.limits.maxDevicesPerInstance) return this.capacity(scope, true);
        if (this.count('presence_observer_device') >= this.limits.maxDevices) return this.capacity(scope);
        this.db.prepare('INSERT INTO presence_observer_device(instance_id,node_id) VALUES(?,?)').run(scope.instanceId, scope.nodeId);
      }
      let observer = this.observer(scope);
      if (!observer) {
        if (this.count('presence_observer', scope.instanceId) >= this.limits.maxObserversPerInstance) return this.capacity(scope, true);
        if (this.count('presence_observer') >= this.limits.maxObservers) return this.capacity(scope);
        this.db.prepare('INSERT INTO presence_observer(instance_id,node_id,observer_id,lease_expires_at) VALUES(?,?,?,?)')
          .run(...key, this.now() + this.limits.leaseDurationMs);
        observer = this.observer(scope)!;
      }
      let run = this.run(scope, runNonce);
      if (run) {
        const active = observer.lifecycle === 'active' && observer.current_run === runNonce && run.activated_generation === observer.revision;
        if (!active && (run.activated_generation !== null || run.expected_revision !== observer.revision)) return conflict();
        if (run.ticket_expires_at <= this.now()) {
          const ticket = active ? run.ticket : randomBytes(24).toString('base64url');
          const expiresAt = this.now() + this.limits.ticketTtlMs;
          this.db.prepare('UPDATE presence_observer_run SET ticket=?,ticket_expires_at=? WHERE instance_id=? AND node_id=? AND observer_id=? AND run_nonce=?')
            .run(ticket, expiresAt, ...key, runNonce);
          run = this.run(scope, runNonce)!;
        }
        return { ticket: run.ticket, expectedRevision: run.expected_revision, expiresAt: run.ticket_expires_at };
      }
      if (this.count('presence_observer_run', scope.instanceId) >= this.limits.maxRunsPerInstance) return this.capacity(scope, true);
      if (this.count('presence_observer_run') >= this.limits.maxRuns) return this.capacity(scope);
      const ticket = randomBytes(24).toString('base64url'), expiresAt = this.now() + this.limits.ticketTtlMs;
      this.db.prepare('INSERT INTO presence_observer_run(instance_id,node_id,observer_id,run_nonce,expected_revision,ticket,ticket_expires_at) VALUES(?,?,?,?,?,?,?)')
        .run(...key, runNonce, observer.revision, ticket, expiresAt);
      return { ticket, expectedRevision: observer.revision, expiresAt };
    })();
    // A capacity failure must commit its unknown-source guard before it is surfaced to the caller.
    if (result instanceof PresenceObserverError) throw result;
    this.recordActivity(scope.instanceId);
    return result;
  }

  activate(scope: ObserverScope, input: { runNonce: string; ticket: string }): ObserverActivation {
    const key = identity(scope); assertObserverId(input.runNonce);
    if (typeof input.ticket !== 'string' || input.ticket.length > 128) throw conflict();
    const result = this.db.transaction(() => {
      const row = this.observer(scope), run = this.run(scope, input.runNonce);
      if (!row || !run || run.ticket !== input.ticket) throw conflict();
      if (row.lifecycle === 'active' && row.current_run === input.runNonce && run.activated_generation === row.revision) return this.activation(row);
      if (run.activated_generation !== null || row.revision !== run.expected_revision) throw conflict();
      if (run.ticket_expires_at <= this.now()) throw new PresenceObserverError('OBSERVER_TICKET_EXPIRED', '采集启动凭据已过期，请重新请求本次启动凭据');
      const generation = next(row.revision), lease = this.now() + this.limits.leaseDurationMs;
      const updated = this.db.prepare("UPDATE presence_observer SET revision=?,current_run=?,last_sequence=0,state='unknown',lifecycle='active',lease_expires_at=? WHERE instance_id=? AND node_id=? AND observer_id=? AND revision=?")
        .run(generation, input.runNonce, lease, ...key, run.expected_revision);
      if (updated.changes !== 1) throw conflict();
      this.db.prepare('UPDATE presence_observer_run SET activated_generation=? WHERE instance_id=? AND node_id=? AND observer_id=? AND run_nonce=?')
        .run(generation, ...key, input.runNonce);
      return this.activation(this.observer(scope)!);
    })();
    this.recordActivity(scope.instanceId);
    return result;
  }

  accept(scope: ObserverScope, event: ObserverEvent, commitSample?: () => void): ObserverAcceptance {
    const key = identity(scope); assertObserverId(event.runNonce); assertObserverCounter(event.generation); assertObserverCounter(event.sequence);
    if (!['sample', 'status'].includes(event.kind) || (event.kind === 'status' && event.online !== false)) {
      throw new PresenceObserverError('INVALID_OBSERVER_EVENT', '采集观察事件格式无效', 400);
    }
    const result = this.db.transaction(() => {
      const row = this.observer(scope);
      const ignored = (reason: 'stale' | 'duplicate'): ObserverAcceptance => ({ accepted: false, reason, state: this.aggregate(scope.instanceId, scope.nodeId), freshData: false });
      if (!row || row.lifecycle !== 'active' || row.current_run !== event.runNonce || row.revision !== event.generation || row.lease_expires_at <= this.now()) return ignored('stale');
      if (event.sequence <= row.last_sequence) return ignored(event.sequence === row.last_sequence ? 'duplicate' : 'stale');
      if (event.kind === 'sample' && commitSample) {
        const value: unknown = commitSample();
        if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('presence sample commit must be synchronous');
      }
      const online = event.kind === 'sample' || event.online;
      this.db.prepare('UPDATE presence_observer SET last_sequence=?,state=? WHERE instance_id=? AND node_id=? AND observer_id=?')
        .run(event.sequence, online ? 'online' : 'offline', ...key);
      return { accepted: true, state: this.aggregate(scope.instanceId, scope.nodeId), freshData: event.kind === 'sample' };
    })();
    if (result.accepted) this.recordActivity(scope.instanceId);
    return result;
  }

  renew(scope: ObserverScope, input: { runNonce: string; generation: number }): ObserverActivation {
    const key = identity(scope); assertObserverId(input.runNonce); assertObserverCounter(input.generation);
    const result = this.db.transaction(() => {
      const row = this.observer(scope), run = this.run(scope, input.runNonce);
      if (!row || !run || row.lifecycle !== 'active' || row.current_run !== input.runNonce) throw conflict();
      if (row.revision !== input.generation) {
        // Lost renewal response: return the one replacement already committed, never extend it again.
        if (run.previous_generation === input.generation && run.activated_generation === row.revision && row.lease_expires_at > this.now()) return this.activation(row);
        throw conflict();
      }
      const lease = this.now() + this.limits.leaseDurationMs;
      if (row.lease_expires_at <= this.now()) {
        const generation = next(row.revision);
        this.db.prepare("UPDATE presence_observer SET revision=?,last_sequence=0,state='unknown',lease_expires_at=? WHERE instance_id=? AND node_id=? AND observer_id=?")
          .run(generation, lease, ...key);
        this.db.prepare('UPDATE presence_observer_run SET activated_generation=?,previous_generation=? WHERE instance_id=? AND node_id=? AND observer_id=? AND run_nonce=?')
          .run(generation, row.revision, ...key, input.runNonce);
      } else {
        this.db.prepare('UPDATE presence_observer SET lease_expires_at=? WHERE instance_id=? AND node_id=? AND observer_id=?').run(lease, ...key);
      }
      return this.activation(this.observer(scope)!);
    })();
    this.recordActivity(scope.instanceId);
    return result;
  }

  hasObservers(instanceId: string, nodeId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM presence_observer_device WHERE instance_id=? AND node_id=?').get(instanceId, nodeId);
  }
  aggregate(instanceId: string, nodeId: string): boolean | undefined {
    const device = this.db.prepare('SELECT blocked_unknown FROM presence_observer_device WHERE instance_id=? AND node_id=?').get(instanceId, nodeId) as { blocked_unknown: number } | undefined;
    if (!device) return undefined;
    const states = this.db.prepare('SELECT state FROM presence_observer WHERE instance_id=? AND node_id=?').all(instanceId, nodeId) as { state: string }[];
    if (states.some(row => row.state === 'online')) return true;
    return !device.blocked_unknown && states.length > 0 && states.every(row => row.state === 'offline') ? false : undefined;
  }
  listAggregates(instanceId?: string): ObserverAggregate[] {
    const rows = (instanceId === undefined
      ? this.db.prepare('SELECT instance_id,node_id FROM presence_observer_device').all()
      : this.db.prepare('SELECT instance_id,node_id FROM presence_observer_device WHERE instance_id=?').all(instanceId)) as { instance_id: string; node_id: string }[];
    return rows.map(row => ({ instanceId: row.instance_id, nodeId: row.node_id, state: this.aggregate(row.instance_id, row.node_id) }));
  }
  markUnknown(scope: ObserverScope): ObserverAggregate {
    this.db.prepare("UPDATE presence_observer SET state='unknown' WHERE instance_id=? AND node_id=? AND observer_id=? AND lifecycle='active'").run(...identity(scope));
    return { instanceId: scope.instanceId, nodeId: scope.nodeId, state: this.aggregate(scope.instanceId, scope.nodeId) };
  }
  markAllUnknown(): ObserverAggregate[] {
    this.db.prepare("UPDATE presence_observer SET state='unknown' WHERE state='online' AND lifecycle='active'").run();
    return this.listAggregates();
  }
  private fence(scope: ObserverScope, lifecycle: 'stopped' | 'retired', expectedGeneration?: number): ObserverAggregate {
    const key = identity(scope), row = this.observer(scope);
    if (row && (expectedGeneration === undefined || row.revision === expectedGeneration) && row.lifecycle !== lifecycle) {
      this.db.prepare("UPDATE presence_observer SET revision=?,current_run=NULL,last_sequence=0,state='offline',lifecycle=?,lease_expires_at=0 WHERE instance_id=? AND node_id=? AND observer_id=?")
        .run(next(row.revision), lifecycle, ...key);
    }
    return { instanceId: scope.instanceId, nodeId: scope.nodeId, state: this.aggregate(scope.instanceId, scope.nodeId) };
  }
  retireObserver(scope: ObserverScope, expectedGeneration?: number): ObserverAggregate {
    return this.db.transaction(() => this.fence(scope, 'retired', expectedGeneration))();
  }
  stopInstance(instanceId: string): ObserverAggregate[] {
    assertObserverId(instanceId);
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM presence_observer WHERE instance_id=? AND lifecycle='active'").all(instanceId) as ObserverRow[];
      for (const row of rows) this.fence({ instanceId, nodeId: row.node_id, observerId: row.observer_id }, 'stopped');
      return this.listAggregates(instanceId);
    })();
  }
  expireLeases(): ObserverAggregate[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT DISTINCT instance_id,node_id FROM presence_observer WHERE lifecycle='active' AND lease_expires_at<=? AND state!='offline'").all(this.now()) as { instance_id: string; node_id: string }[];
      this.db.prepare("UPDATE presence_observer SET state='offline' WHERE lifecycle='active' AND lease_expires_at<=? AND state!='offline'").run(this.now());
      return rows.map(row => ({ instanceId: row.instance_id, nodeId: row.node_id, state: this.aggregate(row.instance_id, row.node_id) }));
    })();
  }
}
