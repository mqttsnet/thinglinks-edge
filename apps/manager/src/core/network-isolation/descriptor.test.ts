import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDescriptor, containsAddress, type NetworkDescriptor } from './descriptor.ts';

export const descriptor: NetworkDescriptor = {
  networkId: 'a'.repeat(64), cidr: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false,
  protectedHosts: ['192.168.65.254'], peerCIDRs: ['172.24.0.0/16'],
  allowedHostEndpoints: [{ address: '192.168.65.254', port: 55001, protocol: 'tcp' }],
};

test('network descriptor accepts only exact IPv4 Docker bridge identities and bounded endpoints', () => {
  assert.deepEqual(parseDescriptor(descriptor), descriptor);
  for (const change of [
    { networkId: 'name' }, { cidr: '172.23.1.1/16' }, { gateway: '172.24.0.1' }, { bridge: 'eth0' },
    { ipv6Enabled: true }, { ipv6Enabled: undefined }, { protectedHosts: ['::1'] }, { peerCIDRs: ['172.23.0.0/16'] },
    { allowedHostEndpoints: [{ address: 'host.example', port: 80, protocol: 'tcp' }] },
    { allowedHostEndpoints: [{ address: '192.168.65.254', port: '80', protocol: 'tcp' }] },
    { allowedHostEndpoints: [{ address: '192.168.65.254', port: 80, protocol: 'all' }] },
    { command: 'iptables -F' }, { protectedHosts: Array(129).fill('192.168.65.254') },
  ]) assert.throws(() => parseDescriptor({ ...descriptor, ...change }));
});

test('source CIDR checks use the actual peer IPv4 including IPv4-mapped addresses', () => {
  assert.equal(containsAddress('172.23.0.0/16', '172.23.1.2'), true);
  assert.equal(containsAddress('172.23.0.0/16', '::ffff:172.23.1.2'), true);
  assert.equal(containsAddress('172.23.0.0/16', '172.24.0.2'), false);
  assert.equal(containsAddress('172.23.0.0/16', '::1'), false);
  assert.equal(containsAddress('172.23.0.0/16', '172.023.0.2'), false);
});
