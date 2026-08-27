import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, describe } from './index.ts';

test('版本号形如 x.y.z', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('describe 含产品名与版本', () => {
  const s = describe();
  assert.ok(s.includes('ThingLinks Edge Manager'));
  assert.ok(s.includes(VERSION));
});
