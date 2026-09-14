import test from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_POLICY_DEFAULTS, deploymentRealm, validatePolicyConfig, type PolicyConfig } from './config.ts';

const base = (): PolicyConfig => ({ ...structuredClone(NETWORK_POLICY_DEFAULTS), dataRoot: '/managed/instances', stateRoot: '/private-policy',
  networkPrefix: 'tle-edge', managerContainer: 'tle-manager', imageRepo: 'nodered/node-red', allowedTags: ['5.0.4-24-minimal'],
  allowedImageIds: [], portRange: { min: 30000, max: 30999 } });

test('host-service exceptions are exact IPv4 endpoints and cannot open management surfaces', () => {
  const config = base();
  config.allowedHostEndpoints = [{ address: '192.168.65.254', port: 11883, protocol: 'tcp' }];
  validatePolicyConfig(config);
  for (const port of [22, 1880, 2375, 2376, 19100, 19200, 19263, 31555]) {
    assert.throws(() => validatePolicyConfig({ ...config, allowedHostEndpoints: [{ address: '192.168.65.254', port, protocol: 'tcp' }] }));
  }
  assert.throws(() => validatePolicyConfig({ ...config, protectedHosts: ['host.docker.internal'] }));
  assert.throws(() => validatePolicyConfig({ ...config, allowedHostEndpoints: [{ address: '::1', port: 11883, protocol: 'tcp' }] }));
  assert.throws(() => validatePolicyConfig({ ...config, allowedHostEndpoints: [{ address: '192.168.65.254', port: 11883, protocol: 'tcp', command: 'not allowed' }] as never }));
  assert.throws(() => validatePolicyConfig({ ...config, stateRoot: '/managed/instances/policy' }));
});

test('trusted deployment roots and network prefixes define distinct stable realms', () => {
  const config = base();
  assert.match(deploymentRealm(config), /^[a-f0-9]{64}$/);
  assert.equal(deploymentRealm(config), deploymentRealm(base()));
  assert.notEqual(deploymentRealm(config), deploymentRealm({ ...config, dataRoot: '/another/instances' }));
  assert.notEqual(deploymentRealm(config), deploymentRealm({ ...config, networkPrefix: 'another-edge' }));
});
