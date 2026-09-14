import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointIdentity, rawPointMappings, resolvePoints, resolveServiceCode } from './service-mapping.ts';

const point = (property = 'temperature', serviceCode?: string, source = 'reading') => ({ source, property, serviceCode, dataType: 'number', scale: 1, offset: 0 });

test('point services inherit the default or resolve explicitly without mutating saved points', () => {
  const points = [point('temperature'), point('temperature', 'power')];
  const resolved = resolvePoints(points, 'environment');
  assert.deepEqual(resolved.map(p => p.serviceCode), ['environment', 'power']);
  assert.equal(points[0]!.serviceCode, undefined);
  assert.equal(resolveServiceCode('   ', 'environment'), 'environment');
  assert.equal(resolveServiceCode('power', ''), 'power');
  assert.throws(() => resolveServiceCode('', ''), /服务编码/);
  assert.throws(() => resolveServiceCode('bad/service', 'environment'), /服务编码/);
  for (const reserved of ['__proto__', 'prototype', 'constructor']) assert.throws(() => resolveServiceCode(reserved), /服务编码/);
  assert.notEqual(pointIdentity('a.b', 'c'), pointIdentity('a', 'b.c'));
});

test('uniqueness belongs to service and property, with 300 total points and 32 services', () => {
  assert.equal(resolvePoints([point('value', 'a'), point('value', 'b')], '').length, 2);
  assert.throws(() => resolvePoints([point('value'), point('value', 'a')], 'a'), /重复/);
  assert.throws(() => resolvePoints([point('value')], ''), /第 1 行.*服务编码/);
  assert.equal(resolvePoints(Array.from({ length: 300 }, (_, i) => point(`p${i}`, `s${i % 32}`)), '').length, 300);
  assert.throws(() => resolvePoints(Array.from({ length: 301 }, (_, i) => point(`p${i}`)), 'a'), /300/);
  assert.throws(() => resolvePoints(Array.from({ length: 33 }, (_, i) => point('value', `s${i}`)), ''), /32/);
});

test('native read aliases separate same-name properties and reuse one source/type across services', () => {
  const resolved = resolvePoints([point('value', 'a', 'rawA'), point('value', 'b', 'rawB'), point('copy', 'b', 'rawA')], '');
  const compiled = rawPointMappings(resolved);
  assert.deepEqual(compiled.reads, [{ source: 'rawA', alias: 'raw_0', dataType: 'number' }, { source: 'rawB', alias: 'raw_1', dataType: 'number' }]);
  assert.deepEqual(compiled.points.map(p => p.rawAlias), ['raw_0', 'raw_1', 'raw_0']);
  assert.deepEqual(compiled.points.map(p => p.source), ['rawA', 'rawB', 'rawA']);
  assert.equal(rawPointMappings([{ ...resolved[0]!, dataType: 'Double' }, { ...resolved[0]!, dataType: 'Float' }]).reads.length, 2);
});
