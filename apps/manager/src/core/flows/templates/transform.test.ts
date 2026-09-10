import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { transformScript, opcuaTransformScript } from './transform.ts';

const point = (over: Record<string, unknown> = {}) => ({
  source: 'temperature',
  property: 'temp',
  dataType: 'number',
  scale: 1,
  offset: 0,
  ...over,
});
function run(format: string, payload: unknown, points = [point()]) {
  const errors: string[] = [];
  const script = transformScript({ format, points, nodeId: 'plc-1', serviceCode: 'env' });
  const result = runInNewContext(`(function(msg,node){${script}})(msg,node)`, {
    msg: { payload },
    Buffer,
    node: { error: (s: string) => errors.push(s) },
  });
  return { result, errors };
}
test('JSON maps nested properties, scaling and explicit cloud identity', () => {
  const r = run('json', Buffer.from('{"measure":{"temperature":250},"ok":true}'), [
    point({ source: 'measure.temperature', scale: 0.1 }),
    point({ source: 'ok', property: 'running', dataType: 'boolean' }),
  ]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.payload)), { temp: 25, running: true });
  assert.equal(r.result.nodeId, 'plc-1');
  assert.equal(r.result.serviceId, 'env');
});
test('binary and Modbus word decoding support signed and float byte orders', () => {
  assert.equal(
    run('binary', Buffer.from([0xff, 0xfe]), [point({ source: '0', dataType: 'int16be' })]).result.payload
      .temp,
    -2,
  );
  assert.equal(
    run('registers', [0x41c8, 0x0000], [point({ source: '0', dataType: 'float32be' })]).result.payload.temp,
    25,
  );
  assert.equal(
    run('registers', [0, 0x41c8], [point({ source: '0', dataType: 'float32swap' })]).result.payload.temp,
    25,
  );
});
test('missing, malformed, short and non-finite data never produce an uplink', () => {
  for (const r of [
    run('json', '{bad'),
    run('json', {}),
    run('json', { temperature: '' }),
    run('json', { temperature: Infinity }),
    run('binary', Buffer.from([1]), [point({ source: '0', dataType: 'uint16be' })]),
    run('json', { temperature: 'false' }, [point({ dataType: 'boolean' })]),
  ]) {
    assert.equal(r.result, null);
    assert.equal(r.errors.length, 1);
  }
});
test('parameter text cannot inject executable code', () => {
  const key = 'x";throw new Error("injected");//';
  const r = run('json', { [key]: 5 }, [point({ source: key })]);
  assert.equal(r.result.payload.temp, 5);
  assert.equal(r.errors.length, 0);
});

test('OPC UA requires observed Good quality and maps each variable independently', () => {
  const script = opcuaTransformScript('plc-1', 'env', [
    point({ source: 'ns=2;s=Temperature', dataType: 'Double' }),
    point({ source: 'ns=2;s=Running', property: 'running', dataType: 'Boolean' }),
  ]);
  const runOpc = (msg: Record<string, unknown>) =>
    runInNewContext(`(function(msg,node){${script}})(msg,node)`, { msg, Buffer, node: { error: () => {} } });
  assert.equal(
    runOpc({ topic: 'ns=2;s=Temperature', payload: 25, statusCode: { value: 0 } }).payload.temp,
    25,
  );
  assert.equal(
    runOpc({ topic: 'ns=2;s=Running', payload: true, statusCode: { value: 0 } }).payload.running,
    true,
  );
  assert.equal(runOpc({ topic: 'ns=2;s=Temperature', payload: 25, statusCode: { value: 0x80000000 } }), null);
  assert.equal(runOpc({ topic: 'ns=2;s=Temperature', payload: 25 }), null);
});

test('unsafe integers never silently round during JSON parsing, conversion or scaling', () => {
  for (const r of [
    run('json', '{"temperature":9007199254740993}'),
    run('json', { temperature: '9007199254740993' }),
    run('json', { temperature: 9007199254740991 }, [point({ scale: 2 })]),
    run('json', '{"temperature":9007199254740993}', [point({ dataType: 'string' })]),
  ]) {
    assert.equal(r.result, null);
    assert.equal(r.errors.length, 1);
  }
  assert.equal(
    run('json', { temperature: '9007199254740993' }, [point({ dataType: 'string' })]).result.payload.temp,
    '9007199254740993',
  );
});
