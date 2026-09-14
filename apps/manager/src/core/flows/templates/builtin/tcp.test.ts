import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tcpRecipe } from './tcp.ts';
import { getBuiltinTemplate, renderBuiltinTemplate } from '../catalog.ts';
const identity = { nodeId: 'tcp-device', serviceCode: 'telemetry' };
const render = (input: Record<string, unknown> = {}) => renderBuiltinTemplate(tcpRecipe.id, { ...identity, ...input })!;

test('TCP exposes only mode-relevant host and fixed-length controls while its server example stays valid', () => {
  const host = tcpRecipe.parameters.find(field => field.key === 'host')!;
  assert.equal(host.default, ''); assert.equal(host.required, true);
  assert.deepEqual(host.visibleWhen, { key: 'mode', value: 'client' });
  assert.deepEqual(tcpRecipe.parameters.find(field => field.key === 'frameLength')?.visibleWhen, { key: 'framing', value: 'fixed' });
  assert.equal(getBuiltinTemplate(tcpRecipe.id)?.flows.find(node => node.type === 'tab')?.disabled, true);
  const input = render().flows.find(node => node.type === 'tcp in')!;
  assert.equal(input.server, 'server'); assert.equal(input.host, ''); assert.equal(input.port, '15001');
});

test('TCP client requires an explicit host and preserves the remote service port', () => {
  for (const host of [undefined, '', ' ', 'http://192.0.2.10', 'user@192.0.2.10']) {
    assert.throws(() => render({ mode: 'client', host }), /设备地址/);
  }
  const result = render({ mode: 'client', host: ' 192.0.2.10 ', port: 5020 });
  const input = result.flows.find(node => node.type === 'tcp in')!;
  assert.equal(input.server, 'client'); assert.equal(input.host, '192.0.2.10'); assert.equal(input.port, '5020');
  assert.equal(result.flows.find(node => node.type === 'tl-device')?.address, '192.0.2.10:5020');
});

test('TCP newline framing ignores unused frame length, fixed framing validates integer length', () => {
  assert.doesNotThrow(() => render({ framing: 'newline', frameLength: 1.5 }));
  assert.throws(() => render({ framing: 'fixed', frameLength: 1.5 }), /帧长度.*整数/);
  assert.match(String(render({ framing: 'fixed', frameLength: 8 }).flows.find(node => node.id === 'frames')?.func), /length = 8/);
  for (const port of [0, 65536, 1.5, NaN]) assert.throws(() => render({ port }));
});

test('TCP fixed binary frames must cover each complete configured point before deployment', () => {
  const points = [{ source: '2', property: 'temperature', dataType: 'float32be', scale: 1, offset: 0 }];
  assert.throws(() => render({ framing: 'fixed', frameLength: 4, format: 'binary', points }), /第 1 行.*temperature.*2–5.*0–3/);
  assert.doesNotThrow(() => render({ framing: 'fixed', frameLength: 6, format: 'binary', points }));
});

test('TCP instructions distinguish listener mapping, remote port, framing and one logical identity', () => {
  const port = tcpRecipe.parameters.find(field => field.key === 'port')!;
  assert.match(port.description!, /监听.*入站.*连接设备.*远端/);
  assert.match(String(tcpRecipe.parameters.find(field => field.key === 'host')?.description), /127\.0\.0\.1.*实例/);
  assert.match(String(tcpRecipe.parameters.find(field => field.key === 'framing')?.description), /二进制.*换行/);
  assert.match(tcpRecipe.notes.join(' '), /一台逻辑设备.*身份/);
  assert.equal(tcpRecipe.revision, '1.2.0');
});
