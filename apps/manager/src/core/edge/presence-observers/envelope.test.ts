import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePresenceEnvelope, PresenceObserverError } from './index.ts';
const meta = { version: 1, observerId: 'collector', runNonce: 'run', generation: 1, sequence: 1 };
test('legacy payload is unchanged; versioned sample and status envelopes keep all identity metadata together', () => {
  assert.equal(parsePresenceEnvelope({ temperature: 26 }), undefined);
  const value = { __tlePresence: { ...meta, kind: 'sample' }, values: { temperature: 26 } };
  assert.deepEqual(parsePresenceEnvelope(value), value);
  assert.deepEqual(parsePresenceEnvelope({ __tlePresence: { ...meta, kind: 'status', online: false } }), { __tlePresence: { ...meta, kind: 'status', online: false } });
});
test('malformed, empty, conflicting or unknown envelope fields never become live samples', () => {
  for (const value of [
    { __tlePresence: { ...meta, kind: 'sample' }, values: {} },
    { __tlePresence: { ...meta, kind: 'sample' }, values: [] },
    { __tlePresence: { ...meta, kind: 'sample', online: true }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'status', online: 'false' } },
    { __tlePresence: { ...meta, kind: 'status', online: true } },
    { __tlePresence: { ...meta, kind: 'status', online: false, report: false } },
    { __tlePresence: { ...meta, kind: 'sample', report: 'false' }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'status', online: false }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'sample', sequence: 0 }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'sample', version: 2 }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'sample', unexpected: true }, values: { t: 1 } },
    { __tlePresence: { ...meta, kind: 'sample' }, values: { t: 1 }, unexpected: true },
  ]) assert.throws(() => parsePresenceEnvelope(value), PresenceObserverError);
});

test('report:false retains a real sample and its point values for local recording', () => {
  const envelope = { __tlePresence: { ...meta, kind: 'sample', report: false }, values: { t: 1 } };
  assert.deepEqual(parsePresenceEnvelope(envelope), envelope);
});
