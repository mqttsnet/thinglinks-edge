import { NetworkIsolationError, containsAddress, parseDescriptor, validNetworkId, type NetworkDescriptor } from './descriptor.ts';
import { chainFor } from './rules.ts';
import { NetworkOwnershipError, type KernelSnapshot, type NetworkFirewall } from './firewall.ts';
import { MAX_NETWORKS, type DescriptorStore } from './store.ts';

export type FirewallPort = Pick<NetworkFirewall, 'snapshot' | 'ready' | 'sourcePresent' | 'bridgeMatches' | 'assertOwnership' | 'install' | 'remove'>;
export interface NetworkIsolationHealth { supported: boolean; recovered: boolean }

/** Desired state is durable; readiness is always derived from recent real kernel state. */
export class NetworkIsolationController {
  readonly #store: DescriptorStore;
  readonly #firewall: FirewallPort;
  readonly #now: () => number;
  #descriptors = new Map<string, NetworkDescriptor>();
  #pending = new Set<string>();
  #dormant = new Set<string>();
  #removing = new Set<string>();
  #ownershipConflicts = new Set<string>();
  #initialized = false;
  #busy = false;
  #queued = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #epoch = 0;
  #cached: { at: number; epoch: number; value: KernelSnapshot } | undefined;
  #snapshotRequest: { epoch: number; promise: Promise<KernelSnapshot> } | undefined;
  constructor(store: DescriptorStore, firewall: FirewallPort, options: { now?: () => number } = {}) {
    this.#store = store; this.#firewall = firewall; this.#now = options.now ?? Date.now;
  }
  private values(): NetworkDescriptor[] { return [...this.#descriptors.values()]; }
  descriptor(networkId: string): NetworkDescriptor | undefined {
    const value = this.#descriptors.get(networkId);
    return value ? structuredClone(value) : undefined;
  }
  profileState(networkId: string): 'unregistered' | 'source-missing' | 'ownership-conflict' | 'peer-pending' | 'pending' | 'ready' {
    if (!this.#descriptors.has(networkId)) return 'unregistered';
    if (this.#dormant.has(networkId)) return 'source-missing';
    if (this.#ownershipConflicts.has(networkId)) return 'ownership-conflict';
    if (this.#busy || this.#pending.has(networkId)) return 'pending';
    return this.#pending.size > 0 ? 'peer-pending' : 'ready';
  }
  private observe(snapshot: KernelSnapshot): void {
    const known = this.values();
    for (const value of known) {
      if (!this.#firewall.sourcePresent(snapshot, value)) {
        this.#dormant.add(value.networkId); this.#pending.delete(value.networkId);
      } else {
        this.#dormant.delete(value.networkId);
        if (!this.#ownershipConflicts.has(value.networkId) && !this.#removing.has(value.networkId) && this.#firewall.ready(snapshot, value, known)) this.#pending.delete(value.networkId);
        else this.#pending.add(value.networkId);
      }
    }
  }
  private invalidate(): void { this.#epoch++; this.#cached = undefined; }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.#queued >= 32) return Promise.reject(new NetworkIsolationError('网络保护操作繁忙', 429));
    this.#queued++;
    const next = this.#tail.then(async () => {
      this.#busy = true; this.invalidate();
      try { return await work(); } finally { this.#busy = false; this.#queued--; this.invalidate(); }
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
  private async snapshot(): Promise<KernelSnapshot> {
    if (this.#cached && this.#cached.epoch === this.#epoch && this.#now() - this.#cached.at < 1000) return this.#cached.value;
    const epoch = this.#epoch;
    if (this.#snapshotRequest?.epoch !== epoch) {
      const entry = { epoch, promise: this.#firewall.snapshot() };
      this.#snapshotRequest = entry;
      void entry.promise.finally(() => { if (this.#snapshotRequest === entry) this.#snapshotRequest = undefined; }).catch(() => undefined);
    }
    const value = await this.#snapshotRequest.promise;
    if (epoch === this.#epoch) this.#cached = { at: this.#now(), epoch, value };
    return value;
  }
  async initialize(): Promise<void> {
    await this.serialize(async () => {
      const values = (await this.#store.load()).map(parseDescriptor);
      if (values.length > MAX_NETWORKS || new Set(values.map(value => value.networkId)).size !== values.length) throw new NetworkIsolationError('网络保护持久记录无效');
      this.#descriptors = new Map(values.map(value => [value.networkId, value]));
      this.#pending = new Set(this.#descriptors.keys());
      this.#initialized = true;
      await this.repair();
    });
  }
  private async repair(): Promise<void> {
    let snapshot: KernelSnapshot;
    try { snapshot = await this.#firewall.snapshot(); }
    catch { for (const id of this.#descriptors.keys()) this.#pending.add(id); return; }
    if (!snapshot.backendReady) { for (const id of this.#descriptors.keys()) this.#pending.add(id); return; }
    const known = this.values();
    for (const value of known) {
      try {
        if (!this.#firewall.sourcePresent(snapshot, value)) continue;
        this.#firewall.assertOwnership(snapshot, value);
        if (!this.#firewall.ready(snapshot, value, known)) await this.#firewall.install(value, known);
        this.#ownershipConflicts.delete(value.networkId);
      } catch (error) {
        if (error instanceof NetworkOwnershipError) this.#ownershipConflicts.add(value.networkId);
        this.#pending.add(value.networkId);
      }
    }
    try { snapshot = await this.#firewall.snapshot(); }
    catch { for (const id of this.#descriptors.keys()) this.#pending.add(id); return; }
    this.observe(snapshot);
  }
  async reconcile(): Promise<void> {
    if (!this.#initialized || this.#queued > 0) return;
    await this.serialize(() => this.repair());
  }
  async register(input: unknown): Promise<{ registered: true; ready: true; networkId: string }> {
    const descriptor = parseDescriptor(input);
    return this.serialize(async () => {
      if (!this.#initialized) throw new NetworkIsolationError('网络保护尚未恢复');
      const snapshot = await this.#firewall.snapshot();
      if (!this.#firewall.bridgeMatches(snapshot, descriptor)) throw new NetworkIsolationError('实际 bridge 与网络注册信息不符');
      const previous = this.#descriptors.get(descriptor.networkId);
      if (previous && (previous.cidr !== descriptor.cidr || previous.gateway !== descriptor.gateway || previous.bridge !== descriptor.bridge)) throw new NetworkIsolationError('既有网络身份不可修改', 400);
      if (!previous && this.#descriptors.size >= MAX_NETWORKS) throw new NetworkIsolationError('网络保护记录已满', 429);
      const next = new Map(this.#descriptors);
      next.set(descriptor.networkId, { ...descriptor, peerCIDRs: [...new Set([...descriptor.peerCIDRs, ...(previous?.peerCIDRs ?? [])])] });
      for (const [id, value] of next) {
        if (!this.#firewall.sourcePresent(snapshot, value)) continue;
        const peers = [...next.values()].filter(peer => peer.networkId !== id && this.#firewall.sourcePresent(snapshot, peer));
        if (peers.some(peer => peer.bridge === value.bridge || containsAddress(peer.cidr, value.gateway) || containsAddress(value.cidr, peer.gateway)
          || chainFor(peer.networkId) === chainFor(value.networkId))) throw new NetworkIsolationError('网络保护范围冲突', 400);
        next.set(id, parseDescriptor({ ...value, peerCIDRs: [...new Set([...value.peerCIDRs, ...peers.map(peer => peer.cidr)])] }));
      }
      const values = [...next.values()];
      for (const value of values) if (this.#firewall.sourcePresent(snapshot, value)) this.#firewall.assertOwnership(snapshot, value);
      if (JSON.stringify(values) !== JSON.stringify(this.values())) await this.#store.save(values);
      this.#descriptors = next;
      this.#removing.delete(descriptor.networkId);
      for (const id of next.keys()) this.#pending.add(id);
      await this.repair();
      if (!previous && this.#ownershipConflicts.has(descriptor.networkId)) {
        // A competing control domain may claim the chain after our preflight.
        // The create-only kernel transaction cannot overwrite it; retract only
        // the newly published profile, retaining conservative peer protection.
        const retained = this.values().filter(value => value.networkId !== descriptor.networkId);
        await this.#store.save(retained);
        this.#descriptors.delete(descriptor.networkId); this.#pending.delete(descriptor.networkId); this.#ownershipConflicts.delete(descriptor.networkId);
        throw new NetworkOwnershipError();
      }
      if (this.#pending.size > 0) throw new NetworkIsolationError('网络保护尚未完整生效，禁止启动实例');
      return { registered: true, ready: true, networkId: descriptor.networkId };
    });
  }
  async unregister(networkId: string): Promise<{ removed: true; networkId: string }> {
    if (!validNetworkId(networkId)) throw new NetworkIsolationError('网络标识无效', 400);
    return this.serialize(async () => {
      if (!this.#initialized) throw new NetworkIsolationError('网络保护尚未恢复');
      const value = this.#descriptors.get(networkId);
      if (!value) return { removed: true, networkId };
      this.#pending.add(networkId); this.#removing.add(networkId);
      await this.#firewall.remove(value);
      const next = this.values().filter(descriptor => descriptor.networkId !== networkId);
      // Other profiles deliberately retain the former peer CIDR until an explicit
      // future ownership-aware GC exists; removing it here opens a reuse window.
      await this.#store.save(next);
      this.#descriptors.delete(networkId); this.#pending.delete(networkId); this.#dormant.delete(networkId); this.#removing.delete(networkId); this.#ownershipConflicts.delete(networkId);
      return { removed: true, networkId };
    });
  }
  async ready(networkId: string): Promise<boolean> {
    const value = this.#descriptors.get(networkId);
    if (!this.#initialized || this.#busy || !value) return false;
    const epoch = this.#epoch;
    try {
      const snapshot = await this.snapshot();
      if (epoch !== this.#epoch || this.#busy) return false;
      this.observe(snapshot);
      const ready = this.#pending.size === 0 && !this.#dormant.has(networkId) && this.#firewall.ready(snapshot, value, this.values());
      return ready;
    } catch { this.#pending.add(networkId); return false; }
  }
  async health(): Promise<NetworkIsolationHealth> {
    if (!this.#initialized || this.#busy) return { supported: false, recovered: false };
    const epoch = this.#epoch;
    try {
      const snapshot = await this.snapshot();
      if (epoch !== this.#epoch || this.#busy) return { supported: false, recovered: false };
      this.observe(snapshot);
      return { supported: snapshot.backendReady, recovered: snapshot.backendReady && this.#pending.size === 0 };
    } catch { return { supported: false, recovered: false }; }
  }
}
