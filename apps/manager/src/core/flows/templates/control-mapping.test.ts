import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveControlMappings } from './control-mapping.ts';
import { resolvePoints } from './service-mapping.ts';

const points = resolvePoints([
  { serviceCode: 'motor', property: 'speed', source: 'DB1,WORD0', dataType: 'number', scale: 1 },
  { serviceCode: 'fan', property: 'speed', source: 'DB1,WORD2', dataType: 'number', scale: 2 },
]);
test('control rows inherit defaults and allow same command names in separate services', () => {
  const result = resolveControlMappings([
    { cmd: 'setSpeed', param: 'value', property: 'speed' },
    { serviceCode: 'fan', cmd: 'setSpeed', param: 'value', property: 'speed' },
  ], points, 'motor');
  assert.deepEqual(result.map(row => [row.serviceCode, row.targetServiceCode]), [['motor', 'motor'], ['fan', 'fan']]);
  assert.throws(() => resolveControlMappings([result[0], result[0]], points, 'motor'), /同一服务/);
});
test('cross-service targets must be explicit and resolve to a configured unique point', () => {
  const row = { serviceCode: 'control', targetServiceCode: 'fan', cmd: 'setSpeed', param: 'value', property: 'speed' };
  assert.equal(resolveControlMappings([row], points)[0]!.targetServiceCode, 'fan');
  assert.throws(() => resolveControlMappings([{ ...row, targetServiceCode: '' }], points), /点位/);
  assert.throws(() => resolveControlMappings([{ ...row, targetServiceCode: 'other' }], points), /点位/);
});
test('mapping count and combined point-command service count stay bounded', () => {
  const rows = Array.from({ length: 64 }, (_, i) => ({ serviceCode: 'motor', cmd: `set${i}`, param: 'value', property: 'speed' }));
  assert.equal(resolveControlMappings(rows, points).length, 64);
  assert.throws(() => resolveControlMappings([...rows, { ...rows[0], cmd: 'overflow' }], points), /64/);
  const tooMany = Array.from({ length: 32 }, (_, i) => ({ serviceCode: `control${i}`, targetServiceCode: 'motor', cmd: 'set', param: 'value', property: 'speed' }));
  assert.throws(() => resolveControlMappings(tooMany, points), /32/);
});
