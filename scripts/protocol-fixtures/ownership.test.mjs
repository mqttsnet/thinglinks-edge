import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipeTarget } from './ownership.mjs';

const label = 'pt3-00000000-0000-4000-8000-000000000001';
const id = 'a'.repeat(64),
  networkId = 'b'.repeat(64);
const key = 'com.mqttsnet.thinglinks-edge.protocol-verification';
function fixture() {
  return {
    state: {
      label,
      instanceId: id,
      containers: [id],
      network: networkId,
      directory: '/tmp/tle-protocol-verification-test',
      imageId: 'sha256:test',
    },
    info: {
      Id: id,
      Name: `/${label}-node-red`,
      Image: 'sha256:test',
      Config: { Labels: { [key]: label } },
      Mounts: [{ Destination: '/data', Source: '/tmp/tle-protocol-verification-test/data' }],
      NetworkSettings: {
        Ports: { '1880/tcp': [{ HostIp: '127.0.0.1', HostPort: '34567' }] },
        Networks: { test: { NetworkID: networkId } },
      },
    },
    network: { Id: networkId, Internal: true, Labels: { [key]: label }, Containers: { [id]: {} } },
  };
}
test('recipe target URL is derived from owned loopback mapping', () => {
  const { state, info, network } = fixture();
  state.url = 'https://untrusted.example:34567';
  assert.equal(validateRecipeTarget(state, info, network), 'http://127.0.0.1:34567');
});
test('missing labels, foreign identities and mismatched mounts refuse mutations', () => {
  for (const mutate of [
    (s, i) => {
      delete s.label;
      delete i.Config.Labels[key];
    },
    (s) => {
      s.containers = [];
    },
    (_s, i) => {
      i.Name = '/production';
    },
    (_s, i) => {
      i.NetworkSettings.Ports['1880/tcp'][0].HostIp = '0.0.0.0';
    },
    (_s, i) => {
      i.Mounts[0].Source = '/real/data';
    },
    (_s, _i, n) => {
      n.Internal = false;
    },
  ]) {
    const { state, info, network } = fixture();
    mutate(state, info, network);
    assert.throws(() => validateRecipeTarget(state, info, network));
  }
});
