import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instanceRequestHeaders, instanceResponseHeaders } from './proxy-headers.ts';

test('header isolation is case-insensitive, immutable and preserves explicit target credentials', () => {
  const input = { Cookie: 'tle_sid=fake', 'X-CSRF-Token': 'fake', 'X-Forwarded-User': 'admin',
    'X-TLE-Session': 'fake', 'X-ThingLinks-Role': 'admin', 'Remote-User': 'root',
    Authorization: 'Bearer target-only', 'X-Device-Key': 'device-only', 'Content-Type': 'application/json' };
  assert.deepEqual(instanceRequestHeaders(input), { Authorization: 'Bearer target-only', 'X-Device-Key': 'device-only', 'Content-Type': 'application/json' });
  assert.equal(input.Cookie, 'tle_sid=fake');
  const output = { 'Set-Cookie': ['tle_sid=fake'], 'Clear-Site-Data': '"*"', 'Service-Worker-Allowed': '/', 'Content-Type': 'application/json' };
  assert.deepEqual(instanceResponseHeaders(output), { 'Content-Type': 'application/json' });
  assert.deepEqual(output['Set-Cookie'], ['tle_sid=fake']);
});
