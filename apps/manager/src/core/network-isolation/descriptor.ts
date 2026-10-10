import { isIP } from 'node:net';

export interface AllowedHostEndpoint { address: string; port: number; protocol: 'tcp' | 'udp' }
export interface NetworkDescriptor {
  networkId: string;
  cidr: string;
  gateway: string;
  bridge: string;
  ipv6Enabled: false;
  protectedHosts: string[];
  peerCIDRs: string[];
  allowedHostEndpoints: AllowedHostEndpoint[];
}
export class NetworkIsolationError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.name = 'NetworkIsolationError'; this.status = status; }
}
function reject(): never { throw new NetworkIsolationError('网络保护描述无效', 400); }
export const validNetworkId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function ipv4(value: unknown): value is string { return typeof value === 'string' && isIP(value) === 4; }
function numberOf(address: string): number { return address.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0); }
export function cidrParts(value: string): { network: number; mask: number; prefix: number } | undefined {
  const match = /^([^/]+)\/(\d|[12]\d|3[0-2])$/.exec(value);
  if (!match || !ipv4(match[1])) return undefined;
  const prefix = Number(match[2]), mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = numberOf(match[1]);
  return ((network & mask) >>> 0) === network ? { network, mask, prefix } : undefined;
}
export function containsAddress(cidr: string, peer: string): boolean {
  const address = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  const parts = cidrParts(cidr);
  return !!parts && ipv4(address) && ((numberOf(address) & parts.mask) >>> 0) === parts.network;
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) return reject();
  return value as Record<string, unknown>;
}
function array(value: unknown, limit: number): unknown[] { if (!Array.isArray(value) || value.length > limit) return reject(); return value; }
export function parseDescriptor(input: unknown): NetworkDescriptor {
  const value = object(input, ['networkId', 'cidr', 'gateway', 'bridge', 'ipv6Enabled', 'protectedHosts', 'peerCIDRs', 'allowedHostEndpoints']);
  const { networkId, cidr, gateway, bridge } = value;
  if (!validNetworkId(networkId) || typeof cidr !== 'string' || !ipv4(gateway) || bridge !== `br-${networkId.slice(0, 12)}` || value['ipv6Enabled'] !== false) return reject();
  const source = cidrParts(cidr);
  if (!source || source.prefix < 8 || source.prefix > 30 || !containsAddress(cidr, gateway)
    || numberOf(gateway) === source.network || numberOf(gateway) === (source.network | ~source.mask) >>> 0) return reject();
  const protectedHosts = array(value['protectedHosts'], 128).map(address => { if (!ipv4(address)) return reject(); return address; });
  const peerCIDRs = array(value['peerCIDRs'], 512).map(peer => {
    if (typeof peer !== 'string' || !cidrParts(peer) || containsAddress(peer, gateway) || containsAddress(cidr, peer.split('/')[0]!)) return reject();
    return peer;
  });
  const allowedHostEndpoints = array(value['allowedHostEndpoints'], 64).map((raw): AllowedHostEndpoint => {
    const endpoint = object(raw, ['address', 'port', 'protocol']);
    const { address, port, protocol } = endpoint;
    if (!ipv4(address) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || [22, 1880, 2375, 2376].includes(port) || (protocol !== 'tcp' && protocol !== 'udp')) return reject();
    return { address, port, protocol };
  });
  return { networkId, cidr, gateway, bridge: String(bridge), ipv6Enabled: false,
    protectedHosts: [...new Set(protectedHosts)].sort(), peerCIDRs: [...new Set(peerCIDRs)].sort(),
    allowedHostEndpoints: [...new Map(allowedHostEndpoints.map(endpoint => [JSON.stringify(endpoint), endpoint])).values()]
      .sort((a, b) => a.address.localeCompare(b.address) || a.port - b.port || a.protocol.localeCompare(b.protocol)) };
}
