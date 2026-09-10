import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMid, midKey } from './mid.ts';

test('canonical mid preserves exact positive signed long integers and safe-number compatibility', () => {
  assert.equal(normalizeMid('42'),42);
  assert.equal(normalizeMid('9007199254740991'),Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeMid('9007199254740992'),'9007199254740992');
  assert.equal(normalizeMid('9223372036854775807'),'9223372036854775807');
  assert.equal(midKey(42),midKey('42'));
  assert.notEqual(midKey('480000000000000001'),midKey('480000000000000002'));
  for(const value of [Number.MAX_SAFE_INTEGER+1,NaN,Infinity,0,-1,'0','01','+1','1.0','1e3',' 1 ','9223372036854775808']) {
    assert.throws(()=>normalizeMid(value),/mid/);
  }
});
