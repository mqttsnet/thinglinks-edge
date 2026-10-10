import { randomBytes } from 'node:crypto';
import { demand, deploymentRealm, object, PolicyDenied, type PolicyConfig } from './config.ts';
import { ownerFromLabels } from './ownership.ts';
import { NETWORK_POLICY_OP_LABEL, NETWORK_POLICY_REALM_LABEL, type NetworkIntent, type NetworkIntentStore } from './network-intents.ts';
import { buildNetworkDescriptor, waitForNetworkGuard, type NetworkGuardClient } from './network-guard.ts';
import type { NetworkDescriptor } from '../network-isolation/descriptor.ts';

export interface NetworkDaemon {
  json(path: string, signal?: AbortSignal): Promise<unknown>;
  deleteNetwork(networkId: string, signal?: AbortSignal): Promise<void>;
}
export interface NetworkOperation {
  body: Record<string, unknown>;
  beforeDispatch(): Promise<void>;
  succeeded(body: unknown): Promise<void>;
  failed(dispatched: boolean): Promise<void>;
}

/** Registration is part of the Docker transaction; no Node-RED start is permitted before its receipt. */
export class NetworkCoordinator {
  private readonly config: PolicyConfig;
  private readonly daemon: NetworkDaemon;
  private readonly guard: NetworkGuardClient;
  private readonly store: Pick<NetworkIntentStore, 'begin' | 'recordCreated' | 'pending' | 'commit'>;
  private readonly wait: { timeoutMs: number; intervalMs: number };
  constructor(
    config: PolicyConfig, daemon: NetworkDaemon, guard: NetworkGuardClient,
    store: Pick<NetworkIntentStore, 'begin' | 'recordCreated' | 'pending' | 'commit'>,
    wait = { timeoutMs: 10_000, intervalMs: 100 },
  ) { this.config = config; this.daemon = daemon; this.guard = guard; this.store = store; this.wait = wait; }

  private waitGuard(action: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    return waitForNetworkGuard(action, signal, this.wait);
  }

  private owner(network: Record<string, unknown>, strictRealm = true): void {
    const owner = ownerFromLabels(network['Labels'], this.config, true);
    const realm = object(network['Labels'])[NETWORK_POLICY_REALM_LABEL];
    demand((!strictRealm && realm === undefined) || realm === deploymentRealm(this.config));
    demand(network['Name'] === owner.networkName && typeof network['Id'] === 'string' && /^[a-f0-9]{64}$/.test(network['Id'])
      && network['Driver'] === 'bridge' && network['EnableIPv6'] === false);
  }
  private async inspect(id: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    try { return object(await this.daemon.json(`/networks/${id}`, signal)); }
    catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return undefined; throw error; }
  }
  private async snapshots(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    signal.throwIfAborted();
    const listed = await this.daemon.json('/networks', signal);
    demand(Array.isArray(listed) && listed.length <= 512);
    const result: Record<string, unknown>[] = [];
    for (const entry of listed) {
      signal.throwIfAborted();
      const id = object(entry)['Id']; demand(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
      const network = await this.inspect(id, signal); if (network) result.push(network);
    }
    return result;
  }
  private async refreshProfiles(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const snapshots = await this.snapshots(signal);
    for (const network of snapshots) {
      const labels = object(network['Labels'] ?? {});
      if (typeof labels[NETWORK_POLICY_OP_LABEL] !== 'string' || !/^[a-f0-9]{32}$/.test(labels[NETWORK_POLICY_OP_LABEL])) continue;
      try { this.owner(network); } catch { continue; } // Other independently deployed Edge roots retain their owner.
      await this.waitGuard(current => this.guard.register(buildNetworkDescriptor(network, snapshots, this.config), current), signal);
    }
    return snapshots;
  }

  async ready(network: Record<string, unknown>, parentSignal?: AbortSignal): Promise<NetworkDescriptor> {
    const timeout = AbortSignal.timeout(30_000), signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    this.owner(network);
    const id = String(network['Id']), marker = object(network['Labels'])[NETWORK_POLICY_OP_LABEL];
    if (this.store.pending().some(intent => intent.name === network['Name'] || intent.networkId === id)) throw new PolicyDenied(503);
    demand(typeof marker === 'string' && /^[a-f0-9]{32}$/.test(marker));
    await this.waitGuard(current => this.guard.assertAvailable(current), signal);
    const snapshots = await this.snapshots(signal);
    const descriptor = buildNetworkDescriptor(network, snapshots, this.config);
    await this.waitGuard(current => this.guard.register(descriptor, current), signal);
    await this.waitGuard(current => this.guard.assertReady(id, current), signal);
    return descriptor;
  }

  async prepareCreate(body: Record<string, unknown>, parentSignal?: AbortSignal): Promise<NetworkOperation> {
    const signal = AbortSignal.timeout(30_000);
    const availabilitySignal = parentSignal ? AbortSignal.any([parentSignal, signal]) : signal;
    await this.waitGuard(current => this.guard.assertAvailable(current), availabilitySignal);
    availabilitySignal.throwIfAborted();
    if (await this.inspect(String(body['Name']), availabilitySignal)) throw new PolicyDenied(409);
    const opId = randomBytes(16).toString('hex');
    const labels = { ...object(body['Labels']), [NETWORK_POLICY_OP_LABEL]: opId,
      [NETWORK_POLICY_REALM_LABEL]: deploymentRealm(this.config) } as Record<string, string>;
    let intent = this.store.begin({ opId, kind: 'create', name: String(body['Name']), labels });
    let completed = false;
    return {
      body: { ...body, Labels: labels },
      beforeDispatch: async () => undefined,
      succeeded: async value => {
        const id = object(value)['Id']; demand(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
        intent = this.store.recordCreated(opId, id);
        const network = await this.inspect(id, signal); demand(network);
        this.assertExactIntent(network, intent);
        await this.refreshProfiles(signal);
        await this.waitGuard(current => this.guard.assertReady(id, current), signal);
        this.store.commit(opId); completed = true;
      },
      failed: async dispatched => {
        if (completed) return;
        if (!dispatched) { this.store.commit(opId); return; }
        await this.rollbackCreate(intent, AbortSignal.timeout(30_000));
      },
    };
  }

  private assertExactIntent(network: Record<string, unknown>, intent: NetworkIntent): void {
    this.owner(network, intent.kind === 'create');
    const labels = object(network['Labels']);
    demand(network['Name'] === intent.name && (!intent.networkId || network['Id'] === intent.networkId)
      && Object.entries(intent.labels).every(([key, value]) => labels[key] === value));
  }

  private async rollbackCreate(intent: NetworkIntent, signal: AbortSignal): Promise<void> {
    const network = await this.inspect(intent.networkId ?? intent.name, signal);
    if (!network) {
      // An unknown response may still complete later. Only a recorded immutable id
      // being absent proves the originally created network cannot return under that id.
      if (!intent.networkId) throw new PolicyDenied(503);
      await this.waitGuard(current => this.guard.unregister(intent.networkId!, current), signal); this.store.commit(intent.opId); return;
    }
    this.assertExactIntent(network, intent);
    demand(Object.keys(object(network['Containers'] ?? {})).length === 0);
    const id = String(network['Id']);
    await this.waitGuard(current => this.guard.unregister(id, current), signal);
    signal.throwIfAborted();
    await this.daemon.deleteNetwork(id, signal);
    demand(await this.inspect(id, signal) === undefined);
    this.store.commit(intent.opId);
  }

  async prepareDelete(network: Record<string, unknown>, parentSignal?: AbortSignal): Promise<NetworkOperation> {
    this.owner(network, false);
    demand(Object.keys(object(network['Containers'] ?? {})).length === 0);
    const id = String(network['Id']), name = String(network['Name']);
    const previous = this.store.pending().find(intent => intent.name === name);
    if (previous) this.assertExactIntent(network, previous);
    const intent = previous ?? this.store.begin({ opId: randomBytes(16).toString('hex'), kind: 'delete',
      name, networkId: id, labels: object(network['Labels']) as Record<string, string> });
    let completed = false;
    return {
      body: {},
      beforeDispatch: () => this.waitGuard(current => this.guard.unregister(id, current), parentSignal ?? AbortSignal.timeout(30_000)),
      succeeded: async () => { this.store.commit(intent.opId); completed = true; },
      failed: async () => {
        if (completed) return;
        const signal = AbortSignal.timeout(30_000), current = await this.inspect(id, signal);
        if (current) {
          this.assertExactIntent(current, intent);
          const descriptor = buildNetworkDescriptor(current, await this.snapshots(signal), this.config);
          await this.waitGuard(value => this.guard.register(descriptor, value), signal);
          await this.waitGuard(value => this.guard.assertReady(id, value), signal);
        } else await this.waitGuard(value => this.guard.unregister(id, value), signal);
        this.store.commit(intent.opId);
      },
    };
  }

  async recoverPending(parentSignal?: AbortSignal): Promise<{ recovered: number; pending: number }> {
    parentSignal?.throwIfAborted();
    let recovered = 0;
    const deadline = Date.now() + 30_000;
    for (const intent of this.store.pending()) {
      if (Date.now() >= deadline || parentSignal?.aborted) break;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
        if (intent.kind === 'create') await this.rollbackCreate(intent, signal);
        else {
          const network = await this.inspect(intent.networkId!, signal);
          if (network) {
            this.assertExactIntent(network, intent);
            const descriptor = buildNetworkDescriptor(network, await this.snapshots(signal), this.config);
            await this.waitGuard(value => this.guard.register(descriptor, value), signal);
            await this.waitGuard(value => this.guard.assertReady(intent.networkId!, value), signal);
          } else await this.waitGuard(value => this.guard.unregister(intent.networkId!, value), signal);
          this.store.commit(intent.opId);
        }
        recovered++;
      } catch { /* Preserve unresolved intent; absence or a timeout must never be labelled successful rollback. */ }
    }
    // Deployment-owned host exceptions and protected addresses may have changed
    // while the policy process was down. Refresh only the new strict realm, never legacy networks.
    parentSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30_000);
    await this.refreshProfiles(parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout);
    return { recovered, pending: this.store.pending().length };
  }
}
