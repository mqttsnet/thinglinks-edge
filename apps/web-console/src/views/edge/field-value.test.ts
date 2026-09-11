import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFieldValue } from './field-value.ts';

test('the observed Modbus scaling tail has a compact display and retains the exact returned value', () => {
  const value = 294 * 0.1;
  assert.equal(String(value), '29.400000000000002');
  assert.deepEqual(formatFieldValue(value), { display: '29.4', raw: '29.400000000000002', approximate: true });
  assert.equal(value, 29.400000000000002);
});

test('only machine-scale long decimal tails are shortened, not general high precision measurements', () => {
  assert.equal(formatFieldValue(0.1 + 0.2).display, '0.3');
  assert.equal(formatFieldValue(-29.400000000000002).display, '-29.4');
  assert.equal(formatFieldValue(2.9999999999999996).display, '3');
  for (const value of [1.2345678901234567, 29.400001525878906, 0.10000000000001, 1.2345678901234567e-14, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE]) {
    assert.deepEqual(formatFieldValue(value), { display: String(value), raw: String(value), approximate: false });
  }
});

test('numeric strings, null, booleans and structured values preserve their existing display meaning', () => {
  for (const value of ['29.400000000000002', '9007199254740993', '001.20', true, false]) {
    assert.deepEqual(formatFieldValue(value), { display: String(value), raw: String(value), approximate: false });
  }
  assert.equal(formatFieldValue(null).display, '—');
  const object = { precise: '1.00000000000000001' };
  assert.deepEqual(formatFieldValue(object), { display: JSON.stringify(object), raw: JSON.stringify(object), approximate: false });
  assert.equal(object.precise, '1.00000000000000001');
});

test('unexpected non-finite numbers remain visible and are not disguised as valid readings', () => {
  for (const value of [Infinity, -Infinity, NaN]) assert.equal(formatFieldValue(value).display, String(value));
  assert.deepEqual(formatFieldValue(-0), { display: '-0', raw: '-0', approximate: false });
});
