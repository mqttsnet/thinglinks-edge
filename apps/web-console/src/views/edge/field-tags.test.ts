import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldTagKey, fieldServiceLabel, fieldTagPage, fieldServiceOptions } from './field-tags.ts';
import { fieldQuery } from '../../api/field-query.ts';
import type { FieldTagRecord } from '../../api/types.ts';
const tag = (serviceCode: string, tagId = 'temperature'): FieldTagRecord => ({ instanceId: 'i', nodeId: 'd', serviceCode, tagId, name: '', unit: '', dataType: '', lastValue: 0, quality: 'good', lastAt: null });
test('field identity and service filters keep identical properties and legacy records separate', () => {
  const tags = [tag('b'), tag(''), tag('a')];
  assert.equal(new Set(tags.map(fieldTagKey)).size, 3);
  assert.equal(fieldServiceLabel(''), '旧记录（服务未记录）');
  assert.equal(fieldServiceOptions(tags).length, 4);
  assert.equal(fieldTagPage(tags, '', 1).items[0]?.value.serviceCode, '');
  assert.equal(fieldTagPage(tags, 'b', 1).items[0]?.value.serviceCode, 'b');
  assert.equal(fieldTagPage(Array.from({ length: 300 }, (_, i) => tag('a', 'p' + i)), '*', 12).items.length, 25);
});
test('field query preserves explicitly empty legacy service and safely escapes selected service codes', () => {
  assert.equal(new URLSearchParams(fieldQuery({ instanceId: 'i' })).has('serviceCode'), false);
  const legacy = new URLSearchParams(fieldQuery({ instanceId: 'i', serviceCode: '' }));
  assert.equal(legacy.has('serviceCode'), true); assert.equal(legacy.get('serviceCode'), '');
  assert.equal(new URLSearchParams(fieldQuery({ serviceCode: 's&other=x' })).get('serviceCode'), 's&other=x');
});
