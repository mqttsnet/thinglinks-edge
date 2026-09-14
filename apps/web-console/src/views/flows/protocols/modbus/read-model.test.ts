import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modbusReadConnection, previewRegisterPoints, sameReadConnection } from './read-model.ts';

test('read configuration is independent of Cloud identity and rejects invalid register ranges', () => {
  const valid = modbusReadConnection({ host: '192.0.2.10', registerType: 'HoldingRegister', address: 100, quantity: 4 });
  assert.equal(valid.connection?.host, '192.0.2.10');
  assert.equal(valid.connection?.clientTimeout, 2000);
  assert.deepEqual(valid.issues, []);
  for (const change of [{ host: '' }, { quantity: 601 }, { address: 65535, quantity: 2 }, { unitId: -1 }, { unitId: 256 }]) {
    assert.equal(modbusReadConnection({ ...valid.connection, ...change }).connection, undefined);
  }
  for (const unitId of [0, 255]) assert.equal(modbusReadConnection({ ...valid.connection, unitId }).connection?.unitId, unitId);
});

test('connection comparison ignores point/model edits but detects a different read target', () => {
  const connection = { host: 'meter.local', address: 0, quantity: 2, registerType: 'HoldingRegister' };
  assert.ok(sameReadConnection(connection, { ...connection, points: [], serviceCode: 'changed' }));
  assert.equal(sameReadConnection(connection, { ...connection, address: 2 }), false);
});

test('previews signed values, floats and scaling from the actual register sample', () => {
  const result = previewRegisterPoints([250, 65524, 0x4060, 0], [
    { source: '0', property: 'temperature', dataType: 'uint16be', scale: 0.1, offset: 1 },
    { source: '1', property: 'signed', dataType: 'int16be', scale: 1, offset: 0 },
    { source: '2', property: 'pressure', dataType: 'float32be', scale: 1, offset: 0 },
  ]);
  assert.deepEqual(result.map(row => row.value), [26, -12, 3.5]);
  assert.deepEqual(result.map(row => row.raw), [250, -12, 3.5]);
});

test('read previews keep the effective service on same-named properties', () => {
  const result = previewRegisterPoints([10, 20], [
    { source: '0', property: 'temperature', dataType: 'uint16be' },
    { source: '1', property: 'temperature', serviceCode: 'other', dataType: 'uint16be' },
  ], 'default');
  assert.deepEqual(result.map(row => [row.serviceCode, row.property, row.value]), [['default', 'temperature', 10], ['other', 'temperature', 20]]);
});

test('supports every existing Modbus endian type without silently replacing invalid values', () => {
  const cases: [string, number[], number][] = [
    ['uint16be', [0x1234], 0x1234], ['uint16le', [0x1234], 0x3412],
    ['int16be', [0xfffe], -2], ['int16le', [0xfeff], -2],
    ['uint32be', [0x1234, 0x5678], 0x12345678], ['uint32le', [0x1234, 0x5678], 0x78563412],
    ['int32be', [0xffff, 0xfffe], -2], ['int32le', [0xfeff, 0xffff], -2],
    ['float32be', [0x4060, 0], 3.5], ['float32le', [0, 0x6040], 3.5], ['float32swap', [0, 0x4060], 3.5],
  ];
  for (const [dataType, registers, expected] of cases) {
    assert.equal(previewRegisterPoints(registers, [{ source: '0', dataType }])[0]?.value, expected, dataType);
  }
  for (const point of [{ source: '1', dataType: 'uint16be' }, { source: '0', dataType: 'float32be' },
    { source: '0', dataType: 'uint16be', scale: null }, { source: '-1', dataType: 'uint16be' }]) {
    const row = previewRegisterPoints([250], [point])[0]!;
    assert.ok(row.error); assert.equal(row.value, undefined);
  }
  assert.ok(previewRegisterPoints([NaN], [{ source: '0', dataType: 'uint16be' }])[0]?.error);
});

test('calculated preview retains all 300 point rows including values beyond the first 125 registers', () => {
  const registers = Array.from({ length: 300 }, (_, i) => i + 100);
  const points = registers.map((_, i) => ({ property: `p${i}`, source: String(i), dataType: 'uint16be' }));
  const result = previewRegisterPoints(registers, points);
  assert.equal(result.length, 300); assert.equal(result[299]?.value, 399);
  assert.ok(result.every(row => !row.error));
});

test('one diagnostic configuration can read the full 600-register range', () => {
  assert.equal(modbusReadConnection({ host: 'meter.local', quantity: 600 }).connection?.quantity, 600);
  assert.equal(modbusReadConnection({ host: 'meter.local', quantity: 601 }).connection, undefined);
});
