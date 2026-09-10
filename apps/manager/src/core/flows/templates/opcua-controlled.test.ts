import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { getBuiltinTemplate, renderBuiltinTemplate } from './catalog.ts';
import { parameterDefaults } from './parameters.ts';
import { scanInlineSecrets } from '../scan.ts';

const id = 'builtin:opcua-controlled';
function configured(extra: Record<string, unknown> = {}) {
  const recipe = getBuiltinTemplate(id)!;
  return renderBuiltinTemplate(id, { ...parameterDefaults(recipe.parameters!), nodeId: 'opcua-device', serviceCode: 'telemetry',
    points: [{ source: 'ns=1;s=Temperature', property: 'temperature', dataType: 'Double', scale: 2, offset: 1 }], ...extra })!;
}
function vm(script: unknown, msg: Record<string, unknown>) {
  const errors: string[] = [];
  const result = runInNewContext(`(function(msg){${String(script)}})(msg)`, { msg, Buffer, Date, node: { error: (message: string) => errors.push(message) } });
  return { result, errors };
}
const readResult = (value: unknown = 25) => ({ payload: [{ nodeId: 'ns=1;s=Temperature', alias: 'temperature', value, statusCode: 'Good', sourceTimestamp: '2026-09-10T00:00:00Z' }], opcua: { operation: 'read', total: 1, good: 1, resultDetail: 'compact' } });
function writable() { return configured({ downlinkEnabled: true, commands: [{ cmd: 'set_temperature', param: 'value', property: 'temperature' }] }); }
function writeInput(deadline = Date.now() + 30000, value: unknown = 31) {
  return { payload: { command: { id: 'c-1', leaseToken: 'l-1', deviceIdentification: 'opcua-device', serviceCode: 'telemetry', cmd: 'set_temperature', params: { value }, leaseDeadline: deadline } } };
}

test('template uses only existing tier0 0.6.0 nodes and retains the legacy OPC acquisition recipe', () => {
  const template = configured();
  assert.ok(template.requirements!.some(r => r.module === '@tier0/opcua-client' && r.version === '0.6.0' && r.nodeTypes.includes('tier0-opcua-read')));
  assert.equal(template.flows.some(n => ['exec', 'tl-opcua-read', 'tl-opcua-write', 'OpcUa-Client'].includes(n.type)), false);
  assert.ok(template.flows.some(n => n.type === 'inject'));
  assert.ok(getBuiltinTemplate('builtin:opcua')!.parameters!.find(p => p.key === 'downlinkEnabled')!.disabledReason);
  const connection = template.flows.find(n => n.type === 'tier0-opcua-connection')!;
  assert.equal(connection.commandQueueSize, 1);
  assert.equal(connection.requestTimeout, 8000);
  const read = template.flows.find(n => n.type === 'tier0-opcua-read')!;
  assert.equal(read.connection, 'connection');
  assert.equal(read.resultDetail, 'compact'); assert.equal(read.outputMode, 'batch');
  assert.deepEqual(JSON.parse(String(read.pointList)), [{ nodeId: 'ns=1;s=Temperature', alias: 'temperature' }]);
});

test('certificate and key paths map to actual tier0 fields, while passwords stay out of templates', () => {
  const template = configured({ securityPolicy: 'Basic256Sha256', securityMode: 'SignAndEncrypt', certificateFile: '/data/opcua/client.pem', privateKeyFile: '/data/opcua/client.key', trustedCertificates: '/data/opcua/server.pem;/data/opcua/ca.pem', revocationList: '/data/opcua/revoked.crl' });
  const connection = template.flows.find(n => n.type === 'tier0-opcua-connection')!;
  assert.equal(connection.certificate, '/data/opcua/client.pem'); assert.equal(connection.privateKey, '/data/opcua/client.key');
  assert.deepEqual(connection.trustedCertificates, ['/data/opcua/server.pem', '/data/opcua/ca.pem']);
  assert.deepEqual(connection.revocationList, ['/data/opcua/revoked.crl']);
  assert.equal(connection.credentials, undefined); assert.equal(connection.password, undefined); assert.equal(connection.privateKeyPassword, undefined);
  assert.deepEqual(scanInlineSecrets(template.flows), []);
  assert.throws(() => configured({ password: 'literal-secret' }));
});

test('preflight rejects fractional timeouts, invalid trust references and nonnumeric scaling', () => {
  for (const extra of [
    { timeoutMs: 100.5 }, { interval: 3601 }, { securityPolicy: 'None', securityMode: 'Sign' },
    { securityPolicy: 'Basic256Sha256', securityMode: 'None' },
    { securityPolicy: 'Basic256Sha256', securityMode: 'Sign', certificateFile: '/data/client.pem', privateKeyFile: '/data/client.key' },
    { certificateFile: '/data/client.pem' }, { trustedCertificates: '../server.pem' },
    { endpoint: 'opc.tcp://user:password@device:4840/' }, { privateKeyFile: '-----BEGIN PRIVATE KEY-----\nsecret' },
    ...['Boolean', 'String'].map(dataType => ({ points: [{ source: 'ns=1;s=X', property: 'temperature', dataType, scale: 2, offset: 1 }] })),
  ]) assert.throws(() => configured(extra));
  configured({ timeoutMs: 100, interval: 0.1 }); configured({ timeoutMs: 10000, interval: 3600 });
});

test('compact batch read checks every target and Good quality before standard mapping', () => {
  const decode = configured().flows.find(n => n.id === 'decode')!;
  const good = vm(decode.func, readResult());
  assert.equal(good.result.payload.temperature, 51); assert.equal(good.result.nodeId, 'opcua-device'); assert.equal(good.result.serviceId, 'telemetry');
  for (const msg of [readResult('25'), readResult(Number.NaN), readResult(Infinity),
    { ...readResult(), payload: [] },
    { ...readResult(), payload: [...readResult().payload, ...readResult().payload] },
    { ...readResult(), payload: [{ ...readResult().payload[0], nodeId: 'ns=1;s=Foreign' }] },
    { ...readResult(), payload: [{ ...readResult().payload[0], alias: 'foreign' }] },
    { ...readResult(), payload: [{ ...readResult().payload[0], statusCode: 'BadNotReadable' }] },
    { ...readResult(), opcua: { operation: 'read', total: 2, good: 1, resultDetail: 'compact' } },
  ]) assert.equal(vm(decode.func, msg).result, null);
});

test('command mapping makes one explicit write point and does not pretend tier0 consumes a deadline', () => {
  const template = writable(), encode = template.flows.find(n => n.id === 'control-encode')!, prepare = template.flows.find(n => n.id === 'control-opcua-prepare')!;
  const writer = template.flows.find(n => n.id === 'control-writer')!;
  assert.equal(writer.type, 'tier0-opcua-write'); assert.equal(writer.connection, 'connection');
  assert.deepEqual(writer.wires, [['control-opcua-result']]);
  const encoded = vm(encode.func, writeInput()).result;
  const ready = vm(prepare.func, encoded).result;
  assert.deepEqual(JSON.parse(JSON.stringify(ready.payload)), [{ nodeId: 'ns=1;s=Temperature', dataType: 'Double', value: 15 }]);
  assert.equal(ready.opcuaDeadline, undefined);
  assert.equal(ready._tleCommand.id, 'c-1');
  assert.ok(template.notes!.some(note => note.includes('绝对') && note.includes('截止')));
  assert.equal(vm(prepare.func, vm(encode.func, writeInput(Date.now() + 1000)).result).result, null);
  assert.equal(vm(encode.func, writeInput(Date.now() - 1)).result, null);
});

test('String command JSON remains a value and cannot redirect the existing write node', () => {
  const template = configured({ downlinkEnabled: true, commands: [{ cmd: 'set_temperature', param: 'value', property: 'temperature' }], points: [{ source: 'ns=1;s=Text', property: 'temperature', dataType: 'String', scale: 1, offset: 0 }] });
  const value = '[{"nodeId":"ns=1;s=Foreign","dataType":"Double","value":999}]';
  const encoded = vm(template.flows.find(n => n.id === 'control-encode')!.func, writeInput(Date.now() + 30000, value)).result;
  const ready = vm(template.flows.find(n => n.id === 'control-opcua-prepare')!.func, encoded).result;
  assert.equal(ready.payload.length, 1); assert.equal(ready.payload[0].nodeId, 'ns=1;s=Text'); assert.equal(ready.payload[0].value, value);
  assert.equal(ready.nodeId, undefined); assert.equal(ready.topic, undefined); assert.equal(ready.opcua.pointList, true);
});

test('writer results require exactly the selected target and Good; ambiguous outcomes stay unknown', () => {
  const template = writable(), prepare = template.flows.find(n => n.id === 'control-opcua-prepare')!, encode = template.flows.find(n => n.id === 'control-encode')!;
  const ready = vm(prepare.func, vm(encode.func, writeInput()).result).result;
  const resultNode = template.flows.find(n => n.id === 'control-opcua-result')!;
  const response = (statusCode: string) => ({ ...ready, payload: [{ nodeId: 'ns=1;s=Temperature', statusCode }], opcua: { operation: 'write', total: 1, good: statusCode === 'Good' ? 1 : 0 } });
  assert.equal(vm(resultNode.func, response('Good')).result[0].payload.value, 0);
  assert.equal(vm(resultNode.func, response('BadNotWritable')).result[1]._tleExplicitRejection, true);
  assert.equal(vm(resultNode.func, response('BadTimeout')).result[1]._tleExplicitRejection, false);
  assert.equal(vm(resultNode.func, { ...response('Good'), payload: [] }).result[1]._tleExplicitRejection, false);
  assert.equal(vm(resultNode.func, { ...response('Good'), payload: [{ nodeId: 'ns=1;s=Other', statusCode: 'Good' }] }).result[1]._tleExplicitRejection, false);
  assert.equal(vm(resultNode.func, { ...response('Good'), payload: [...response('Good').payload, ...response('Good').payload] }).result[1]._tleExplicitRejection, false);
});

test('only confirmed queue rejection is classified unattempted; active timeout remains uncertain', () => {
  const error = writable().flows.find(n => n.id === 'control-opcua-error')!;
  for (const message of ['OPC UA client command queue is full', 'Error: OPC UA client command timed out while queued']) {
    const result = vm(error.func, { _tleWriteAttempted: true, error: { message } }).result;
    assert.equal(result._tleWriteAttempted, false); assert.equal(result._tleExplicitRejection, true);
  }
  const result = vm(error.func, { _tleWriteAttempted: true, error: { message: 'Error: Batch write failed: BadTimeout' } }).result;
  assert.equal(result._tleWriteAttempted, true); assert.equal(result._tleExplicitRejection, false);
});
