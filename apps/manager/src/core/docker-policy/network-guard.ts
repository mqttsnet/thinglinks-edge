import { request } from 'node:http';
import { isIP } from 'node:net';
import { parseDescriptor, type NetworkDescriptor } from '../network-isolation/descriptor.ts';
import { demand, object, PolicyDenied, type PolicyConfig } from './config.ts';

export interface NetworkGuardClient {
  assertAvailable(signal?: AbortSignal): Promise<void>;
  register(descriptor: NetworkDescriptor, signal?: AbortSignal): Promise<void>;
  assertReady(networkId: string, signal?: AbortSignal): Promise<void>;
  unregister(networkId: string, signal?: AbortSignal): Promise<void>;
}

/** Reconciliation may briefly report busy. Wait for a new verified receipt, never accept cached readiness. */
export async function waitForNetworkGuard(
  action: (signal: AbortSignal) => Promise<void>, parentSignal?: AbortSignal,
  options = { timeoutMs: 10_000, intervalMs: 100 },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  while (!signal.aborted && Date.now() < deadline) {
    try { await action(signal); signal.throwIfAborted(); return; }
    catch {
      if (signal.aborted) break;
      const delay = Math.min(options.intervalMs, Math.max(0, deadline - Date.now()));
      if (delay <= 0) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, delay); signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  throw new PolicyDenied(503);
}

export function buildNetworkDescriptor(
  network: Record<string, unknown>, peers: unknown[], config: PolicyConfig,
): NetworkDescriptor {
  const id = network['Id'];
  demand(typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) && network['Driver'] === 'bridge' && network['EnableIPv6'] === false);
  const options = object(network['Options'] ?? {});
  demand(options['com.docker.network.bridge.name'] === undefined || options['com.docker.network.bridge.name'] === `br-${id.slice(0, 12)}`);
  const ipam = object(network['IPAM'])['Config'];
  demand(Array.isArray(ipam) && ipam.length === 1);
  const segment = object(ipam[0]);
  const peerCIDRs: string[] = [];
  demand(peers.length <= 4096);
  for (const raw of peers) {
    const peer = object(raw);
    if (peer['Id'] === id) continue;
    const entries = object(peer['IPAM'] ?? {})['Config'] ?? [];
    demand(Array.isArray(entries));
    for (const entry of entries) {
      const cidr = object(entry)['Subnet'];
      if (typeof cidr === 'string' && isIP(cidr.split('/')[0]!) === 4) peerCIDRs.push(cidr);
    }
  }
  return parseDescriptor({
    networkId: id, cidr: segment['Subnet'], gateway: segment['Gateway'], bridge: `br-${id.slice(0, 12)}`, ipv6Enabled: false,
    protectedHosts: [...new Set([...config.protectedHosts, ...config.allowedHostEndpoints.map(endpoint => endpoint.address)])],
    peerCIDRs: [...new Set(peerCIDRs)], allowedHostEndpoints: config.allowedHostEndpoints,
  });
}

export class UnixNetworkGuardClient implements NetworkGuardClient {
  private readonly socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }
  private async call(method: string, path: string, networkId?: string, payload?: unknown, parentSignal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
      const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const req = request({ socketPath: this.socketPath, method, path, signal,
        headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : {},
      }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) { response.destroy(); reject(new PolicyDenied(503)); } else chunks.push(chunk);
        });
        response.once('error', () => reject(new PolicyDenied(503)));
        response.once('end', () => {
          try {
            demand(response.statusCode === 200);
            const value = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            demand(networkId === undefined || value['networkId'] === networkId); resolve(value);
          } catch { reject(new PolicyDenied(503)); }
        });
      });
      req.once('error', () => reject(new PolicyDenied(503))); req.end(body);
    });
  }
  async assertAvailable(signal?: AbortSignal): Promise<void> {
    const value = await this.call('GET', '/healthz', undefined, undefined, signal);
    if (value['supported'] !== true || value['recovered'] !== true) throw new PolicyDenied(503);
  }
  async register(descriptor: NetworkDescriptor, signal?: AbortSignal): Promise<void> {
    const value = await this.call('POST', '/networks/register', descriptor.networkId, parseDescriptor(descriptor), signal);
    if (value['registered'] !== true || value['ready'] !== true) throw new PolicyDenied(503);
  }
  async assertReady(networkId: string, signal?: AbortSignal): Promise<void> {
    demand(/^[a-f0-9]{64}$/.test(networkId));
    if ((await this.call('GET', `/networks/${networkId}/ready`, networkId, undefined, signal))['ready'] !== true) throw new PolicyDenied(503);
  }
  async unregister(networkId: string, signal?: AbortSignal): Promise<void> {
    demand(/^[a-f0-9]{64}$/.test(networkId));
    if ((await this.call('DELETE', `/networks/${networkId}`, networkId, undefined, signal))['removed'] !== true) throw new PolicyDenied(503);
  }
}
