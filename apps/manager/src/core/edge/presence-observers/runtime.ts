import type { PresenceObservers } from './index.ts';
import type { ObserverAggregate } from './types.ts';
import type { FieldRegistry } from '../registry.ts';
import type { PresenceSynchronizer } from '../../cloud/presence/synchronizer.ts';
import { withDeadline } from '../../cloud/presence/deadline.ts';

interface Options {
  observers: Pick<PresenceObservers, 'markAllUnknown' | 'expireLeases' | 'stopInstance' | 'listAggregates' | 'activityVersion'>;
  registry: Pick<FieldRegistry, 'setObservedOnline'>;
  presence: Pick<PresenceSynchronizer, 'observeAggregate'>;
  listInstances(signal: AbortSignal): Promise<{ id: string; running: boolean; state: string }[]>;
  onError?: (message: string) => void;
}
const stopped = new Set(['exited', 'created', 'dead', 'missing', 'removing']);

/** Collector leases are independent of device silence and of whether Cloud is configured. */
export class PresenceObserverRuntime {
  readonly #o: Options;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #round: Promise<void> | undefined;
  #abort: AbortController | undefined;
  constructor(options: Options) { this.#o = options; }

  start(): void {
    if (this.#closed || this.#timer) return;
    for (const item of this.#o.observers.markAllUnknown()) this.#apply(item);
    this.#timer = setInterval(() => { void this.runOnce(); }, 5_000);
    this.#timer.unref();
    void this.runOnce();
  }
  runOnce(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#round) return this.#round;
    const abort = new AbortController(); this.#abort = abort;
    this.#round = this.#run(abort.signal).catch(() => {
      if (!this.#closed) this.#o.onError?.('采集流程运行状态暂未核对，等待重试');
    }).finally(() => { this.#round = undefined; this.#abort = undefined; });
    return this.#round;
  }
  async #run(signal: AbortSignal): Promise<void> {
    for (const item of this.#o.observers.expireLeases()) this.#apply(item);
    const aggregates = this.#o.observers.listAggregates();
    // Cloud may be configured after local startup or reconnect after the last negative event.
    // Keep pending offline/unknown responsibility; cached ONLINE is never fresh evidence.
    for (const item of aggregates) if (item.state !== true) this.#apply(item);
    const activity = new Map(aggregates.map(item =>
      [item.instanceId, this.#o.observers.activityVersion(item.instanceId)]));
    const instances = await withDeadline(current => this.#o.listInstances(current), signal, 3_000);
    if (this.#closed || signal.aborted) return;
    for (const instance of instances) {
      if (!instance.running && stopped.has(instance.state) && activity.has(instance.id)
        && activity.get(instance.id) === this.#o.observers.activityVersion(instance.id)) {
        for (const item of this.#o.observers.stopInstance(instance.id)) this.#apply(item);
      }
    }
  }
  #apply(item: ObserverAggregate): void {
    if (item.state !== undefined) this.#o.registry.setObservedOnline(item.instanceId, item.nodeId, item.state);
    this.#o.presence.observeAggregate(item.instanceId, item.nodeId, item.state, false);
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    await this.#round;
  }
}
