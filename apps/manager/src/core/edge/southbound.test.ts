import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFlows } from './southbound.ts';

/*
 * 下面的报文结构不是编的：字段名与取值取自
 * node-red-contrib-modbus@5.60.2 / -opcua@0.2.355 / -s7@3.1.3
 * 的 `.html` defaults 与包内官方示例流。
 */
const modbusFlow = [
  { id: 'tab1', type: 'tab', label: '流程 1' },
  { id: 'cli1', type: 'modbus-client', name: 'Basics Client', clienttype: 'tcp',
    tcpHost: '127.0.0.1', tcpPort: '10502', unit_id: 1 },
  { id: 'rd1', type: 'modbus-read', name: 'FC3 Holding', server: 'cli1',
    dataType: 'HoldingRegister', adr: '0', quantity: '10', unitid: '1', rate: '1', topic: 'temp' },
  { id: 'dbg1', type: 'debug', z: 'tab1' },
];

test('从真实结构的 modbus 流里认出设备与点位', () => {
  const r = probeFlows(modbusFlow);
  assert.equal(r.devices.length, 1);
  assert.deepEqual(r.devices[0], {
    nodeId: 'cli1', sourceType: 'modbus-client', name: 'Basics Client',
    protocol: 'modbus-tcp', address: '127.0.0.1:10502',
  });
  assert.equal(r.tags.length, 1);
  assert.equal(r.tags[0]!.nodeId, 'cli1', '点位必须能对回它所属的设备');
  assert.equal(r.tags[0]!.address, 'HoldingRegister adr=0 qty=10 unit=1');
});

test('结果恒为「未纳管」—— 这是方案 A 的边界，不是可选项', () => {
  assert.equal(probeFlows(modbusFlow).managed, false);
  assert.equal(probeFlows([]).managed, false);
  assert.equal(probeFlows(null).managed, false);
});

test('串口 modbus 认成 rtu，地址取串口与波特率', () => {
  const r = probeFlows([{ id: 'c', type: 'modbus-client', clienttype: 'serial',
                          serialPort: '/dev/ttyUSB0', serialBaudrate: '9600' }]);
  assert.equal(r.devices[0]!.protocol, 'modbus-rtu');
  assert.equal(r.devices[0]!.address, '/dev/ttyUSB0@9600');
});

test('S7 与 OPC UA 各自的地址形态', () => {
  const r = probeFlows([
    { id: 'e1', type: 's7 endpoint', name: '1#线', address: '192.168.1.5', port: '102', rack: '0', slot: '1' },
    { id: 'v1', type: 's7 in', endpoint: 'e1', variable: 'DB1,INT0', mode: 'single', name: '温度' },
    { id: 'o1', type: 'OpcUa-Endpoint', name: '锅炉', endpoint: 'opc.tcp://10.0.0.9:4840' },
    { id: 'i1', type: 'OpcUa-Item', item: 'ns=2;s=Boiler.Temp', datatype: 'Double', name: '炉温' },
  ]);
  assert.equal(r.devices.length, 2);
  assert.equal(r.devices[0]!.address, '192.168.1.5:102 rack=0 slot=1');
  assert.equal(r.devices[1]!.address, 'opc.tcp://10.0.0.9:4840');
  const s7tag = r.tags.find((t) => t.sourceType === 's7 in')!;
  assert.equal(s7tag.nodeId, 'e1');
  assert.equal(s7tag.address, 'DB1,INT0');
  const opcTag = r.tags.find((t) => t.sourceType === 'OpcUa-Item')!;
  assert.equal(opcTag.address, 'ns=2;s=Boiler.Temp');
  assert.equal(opcTag.nodeId, '', 'OpcUa-Item 不带归属字段，只能留空而不是瞎猜');
});

test('认不出的第三方节点如实上报，不假装看全了', () => {
  const r = probeFlows([
    { id: 'a', type: 'some-vendor-plc' },
    { id: 'b', type: 'some-vendor-plc' },
    { id: 'c', type: 'another-driver' },
    { id: 'd', type: 'inject' },
    { id: 'e', type: 'tl-device' },
  ]);
  assert.deepEqual(r.unrecognized, [
    { type: 'some-vendor-plc', count: 2 },
    { type: 'another-driver', count: 1 },
  ]);
});

test('认得出但不承载设备的节点，不进「认不出」', () => {
  // 从站服务端、响应过滤这些我们知道是什么，混进去会让用户以为平台漏认了
  const r = probeFlows([
    { id: 'a', type: 'modbus-server' },
    { id: 'b', type: 'modbus-response' },
    { id: 'c', type: 'OpcUa-Browser' },
    { id: 'd', type: 's7 control' },
  ]);
  assert.deepEqual(r.unrecognized, []);
  assert.deepEqual(r.devices, []);
});

test('流文件损坏或不是数组时返回空结果，不抛错', () => {
  // 用户的流坏了不该让整个界面挂掉
  for (const bad of [null, undefined, {}, 'not-json', 42]) {
    const r = probeFlows(bad);
    assert.deepEqual(r.devices, []);
    assert.deepEqual(r.tags, []);
  }
  const r = probeFlows([null, 'x', { noType: 1 }, { type: 'modbus-client' }]);
  assert.deepEqual(r.devices, [], '缺 id 的节点应跳过');
});

test('没有名字时退化成用地址，不给空白', () => {
  const r = probeFlows([{ id: 'c', type: 'modbus-client', clienttype: 'tcp',
                          tcpHost: '10.1.1.1', tcpPort: '502' }]);
  assert.equal(r.devices[0]!.name, '10.1.1.1');
});
