import { createHash } from 'node:crypto';
import { ipv4, type NetworkDescriptor } from './descriptor.ts';

export const PARENT_CHAINS = ['DOCKER-USER', 'INPUT'] as const;
export interface RuleSet { chain: string; rules: string[][]; hook: string[]; restore: string }
export function ownerMarker(ownerId: string, networkId: string): string { return `tle-net:${ownerId}:${networkId}`; }
export function chainFor(networkId: string): string { return `TLE_N_${createHash('sha256').update(networkId).digest('hex').slice(0, 16)}`; }

/** The noflush restore transaction declares only our chain; no built-in chain is flushed. */
export function buildRuleSet(descriptor: NetworkDescriptor, healthPort: number, ownerId: string, localHosts: readonly string[] = []): RuleSet {
  const chain = chainFor(descriptor.networkId);
  const rules: string[][] = [
    ['-d', descriptor.gateway, '-p', 'tcp', '-m', 'tcp', '--dport', String(healthPort), '-j', 'RETURN'],
    // Incoming field connections need their responses. Outbound connections from
    // a flow remain ORIGINAL, so revoking their endpoint still drops every packet.
    ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '--ctdir', 'REPLY', '-j', 'RETURN'],
    ...descriptor.allowedHostEndpoints.map(endpoint => ['-p', endpoint.protocol, '-m', 'conntrack', '--ctorigdst', endpoint.address, '--ctorigdstport', String(endpoint.port), '-j', 'RETURN']),
    ...[...new Set([...descriptor.peerCIDRs, ...[descriptor.gateway, ...descriptor.protectedHosts, ...localHosts].map(address => `${address}/32`)])]
      .sort().map(destination => ['-d', destination, '-j', 'DROP']),
    ['-j', 'RETURN'],
  ];
  const tagged = rules.map(rule => [...rule.slice(0, -2), '-m', 'comment', '--comment', ownerMarker(ownerId, descriptor.networkId), ...rule.slice(-2)]);
  return { chain, rules: tagged, hook: ['-s', descriptor.cidr, '-i', descriptor.bridge, '-j', chain],
    restore: [`*filter`, `:${chain} - [0:0]`, ...tagged.map(rule => `-A ${chain} ${rule.join(' ')}`), 'COMMIT', ''].join('\n') };
}

/** Canonical readback comparison retains ordering, verdicts and every selector. */
export function canonicalRule(value: string): string {
  const tokens = value.trim().split(/\s+/);
  return tokens.map((token, index) => {
    if (/^"tle-net:[a-f0-9]{32}:[a-f0-9]{64}"$/.test(token)) return token.slice(1, -1);
    if (tokens[index - 1] === '--ctstate') return token.split(',').sort().join(',');
    return token.endsWith('/32') && ipv4(token.slice(0, -3)) ? token.slice(0, -3) : token;
  }).join(' ');
}
export function chainLines(filter: string, chain: string): string[] {
  return filter.split('\n').filter(line => line.startsWith(`-A ${chain} `)).map(canonicalRule);
}
