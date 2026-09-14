import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkIsolationConfig, assertRuntimeCapabilities } from './config.ts';

test('network service config keeps control state private and endpoints bounded', () => {
  const config = parseNetworkIsolationConfig({});
  assert.equal(config.controlSocket, '/run/tle-network/control.sock');
  assert.equal(config.stateDir, '/run/tle-network/state');
  assert.equal(config.healthPort, 31555);
  assert.deepEqual(parseNetworkIsolationConfig({ TLE_NET_EXTRA_PROTECTED_HOSTS: '192.168.1.20, 192.168.1.20' }).extraProtectedHosts, ['192.168.1.20']);
  for (const change of [{ TLE_NET_HEALTH_PORT: '0' }, { TLE_NET_RECONCILE_MS: '1' }, { TLE_NET_EXTRA_PROTECTED_HOSTS: 'example.com' },
    { TLE_NET_EXTRA_PROTECTED_HOSTS: '::1' }, { TLE_NET_STATE_DIR: '/tmp/outside-private-volume' }, { TLE_NET_CONTROL_SOCKET: 'relative.sock' }]) assert.throws(() => parseNetworkIsolationConfig(change));
});

test('real entry requires Linux uid0 with exactly NET_ADMIN and no-new-privileges', () => {
  const status = 'CapEff:\t0000000000001000\nNoNewPrivs:\t1\n';
  assertRuntimeCapabilities('linux', 0, status);
  assert.throws(() => assertRuntimeCapabilities('darwin', 0, status));
  assert.throws(() => assertRuntimeCapabilities('linux', 1000, status));
  assert.throws(() => assertRuntimeCapabilities('linux', 0, status.replace('1000', '3000')));
  assert.throws(() => assertRuntimeCapabilities('linux', 0, status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')));
});
