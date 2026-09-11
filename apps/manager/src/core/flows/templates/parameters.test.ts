import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParameters, parameterDefaults } from './parameters.ts';
import type { TemplateParameter } from './types.ts';

const fields: TemplateParameter[] = [
  { key: 'host', label: '地址', type: 'text', required: true },
  { key: 'port', label: '端口', type: 'number', default: 502, min: 1, max: 65535 },
  { key: 'mode', label: '模式', type: 'select', default: 'tcp', options: [{ label: 'TCP', value: 'tcp' }] },
  {
    key: 'points',
    label: '点位',
    type: 'table',
    required: true,
    min: 1,
    max: 64,
    columns: [{ key: 'property', label: '属性编码', type: 'text', required: true }],
  },
];
const input = () => ({ host: ' 192.168.1.10 ', points: [{ property: 'temperature' }] });

test('defaults are copied and checked parameters preserve explicit values', () => {
  const result = validateParameters(fields, input());
  assert.deepEqual(result, {
    host: '192.168.1.10',
    port: 502,
    mode: 'tcp',
    points: [{ property: 'temperature' }],
  });
  const defaults = parameterDefaults(fields);
  assert.equal(defaults.port, 502);
  assert.equal(defaults.host, '');
});
test('reject missing required parameters and number coercion', () => {
  for (const value of [
    {},
    { ...input(), host: '' },
    { ...input(), port: '502' },
    { ...input(), port: Infinity },
    { ...input(), port: 0 },
    { ...input(), mode: 'udp' },
  ]) {
    assert.throws(() => validateParameters(fields, value));
  }
});
test('reject unknown keys and prototype pollution including table rows', () => {
  for (const value of [
    { ...input(), command: 'run' },
    JSON.parse('{"__proto__":{}}'),
    { ...input(), points: [JSON.parse('{"property":"a","constructor":{}}')] },
    { ...input(), points: [{ property: 'a', ignored: 1 }] },
  ]) {
    assert.throws(() => validateParameters(fields, value));
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test('table rows and text are bounded and correctly typed', () => {
  for (const value of [
    { ...input(), points: [] },
    { ...input(), points: Array(65).fill({ property: 'a' }) },
    { ...input(), points: [null] },
    { ...input(), host: 'x'.repeat(2049) },
  ]) {
    assert.throws(() => validateParameters(fields, value));
  }
});

test('explicit empty numeric and select values never bypass validation', () => {
  for (const value of [null, '']) {
    assert.throws(() => validateParameters(fields, { ...input(), port: value }));
    assert.throws(() => validateParameters(fields, { ...input(), mode: value }));
  }
  const points: TemplateParameter[] = [
    {
      key: 'points',
      label: '点位',
      type: 'table',
      columns: [{ key: 'scale', label: '倍率', type: 'number', default: 1 }],
    },
  ];
  assert.throws(() => validateParameters(points, { points: [{ scale: '' }] }));
  assert.deepEqual(validateParameters(points, { points: [{}] }), { points: [{ scale: 1 }] });
});
