import { test } from 'node:test';
import assert from 'node:assert/strict';
import { udpRecipe } from './udp.ts';
import { renderBuiltinTemplate } from '../catalog.ts';
const render = (values: Record<string, unknown> = {}) => renderBuiltinTemplate(udpRecipe.id, { nodeId: 'udp-device', serviceCode: 'telemetry', ...values })!;

test('UDP keeps datagram delivery and logical identity on the existing official input pipeline', () => {
  const flow = render({ port: 15005 }).flows;
  const input = flow.find(node => node.type === 'udp in')!;
  assert.equal(input.port, '15005'); assert.equal(input.ipv, 'udp4'); assert.equal(input.datatype, 'buffer');
  assert.deepEqual(input.wires, [['decode']]);
  assert.equal(flow.find(node => node.type === 'tl-device')?.deviceId, 'udp-device');
  assert.equal(flow.find(node => node.type === 'tl-uplink')?.serviceId, 'telemetry');
  assert.equal(flow.some(node => node.id === 'frames'), false);
  for (const port of [-1, 0, 65536, 1.5]) assert.throws(() => render({ port }));
});

test('UDP onboarding explains receiving port, complete datagrams and source identity limits', () => {
  assert.match(String(udpRecipe.parameters.find(field => field.key === 'port')?.description), /实例.*UDP.*映射/);
  assert.match(String(udpRecipe.parameters.find(field => field.key === 'format')?.description), /每个.*数据报.*完整.*换行/);
  const notes = udpRecipe.notes.join(' ');
  assert.match(notes, /一台逻辑设备/);
  assert.match(notes, /来源 IP.*端口.*身份/);
  assert.match(notes, /送达.*顺序/);
  assert.equal(udpRecipe.revision, '1.2.0');
});

test('UDP optional command contract still requires a separate reply port', () => {
  const commands = [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }];
  assert.throws(() => render({ downlinkEnabled: true, commands, commandReplyPort: 15002 }), /命令应答端口/);
  const flow = render({ downlinkEnabled: true, commands, commandHost: '192.0.2.10', commandPort: 15012, commandReplyPort: 15013 }).flows;
  assert.equal(flow.find(node => node.id === 'control-replies')?.port, '15013');
  assert.equal(flow.find(node => node.id === 'control-writer')?.port, '15012');
});
