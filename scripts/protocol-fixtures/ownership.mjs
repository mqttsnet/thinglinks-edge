import assert from 'node:assert/strict';
import { join, basename } from 'node:path';

/** Read-only evidence must establish ownership before a recipe verifier can mutate anything. */
export function validateRecipeTarget(state, info, network) {
  const key = 'com.mqttsnet.thinglinks-edge.protocol-verification';
  assert.match(state.label ?? '', /^pt3-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.match(state.instanceId ?? '', /^[a-f0-9]{64}$/);
  assert.ok(state.containers?.includes(state.instanceId));
  assert.equal(info.Id, state.instanceId);
  assert.equal(info.Name, `/${state.label}-node-red`);
  assert.equal(info.Config.Labels[key], state.label);
  assert.equal(info.Image, state.imageId);
  assert.equal(network.Id, state.network);
  assert.equal(network.Internal, true);
  assert.equal(network.Labels[key], state.label);
  assert.ok(Object.hasOwn(network.Containers, state.instanceId));
  assert.ok(Object.values(info.NetworkSettings.Networks).some((n) => n.NetworkID === state.network));
  assert.ok(basename(state.directory).startsWith('tle-protocol-verification-'));
  assert.equal(
    info.Mounts.find((mount) => mount.Destination === '/data')?.Source,
    join(state.directory, 'data'),
  );
  const ports = info.NetworkSettings.Ports['1880/tcp'];
  assert.equal(ports?.length, 1);
  assert.equal(ports[0].HostIp, '127.0.0.1');
  assert.match(ports[0].HostPort, /^\d{1,5}$/);
  assert.ok(Number(ports[0].HostPort) > 0 && Number(ports[0].HostPort) <= 65535);
  return `http://127.0.0.1:${ports[0].HostPort}`;
}
