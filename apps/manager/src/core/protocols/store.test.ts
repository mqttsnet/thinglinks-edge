import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storedPackageFacts } from './store.ts';
import { CONTROLLED_OPCUA_REQUIREMENT, PROTOCOL_PACKAGE_PINS, protocolStatuses } from './catalog.ts';
import type { NodeStore } from '../nodes/store.ts';
import type { NodeCatalog } from '../nodes/catalog.ts';

const fixture = process.env['TIER0_ARCHIVE_FIXTURE'];
// This public binary archive is an opt-in integration fixture, never fetched by the unit suite.
test('official tier0 archive passes its SRI without becoming an offline dependency or runtime assertion', {
  skip: fixture ? false : 'Set TIER0_ARCHIVE_FIXTURE to the official npm 0.6.0 tgz for this integration gate',
}, () => {
  assert.ok(fixture);
  assert.ok(fixture.endsWith('.tgz'));
  const bytes = readFileSync(fixture);
  const npmSri = 'sha512-XR7rYjJvX3dQx1Z9d7OnmSSg4l3UdOPqKGc+px/+9voyXdXIhTXOtAMzN2VenLgloq+y6lXe55e92OC/YngMpg==';
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, npmSri);
  const catalog = { get: () => ({ version: '0.6.0' }) } as unknown as NodeCatalog;
  const inspect = (archive: Buffer | undefined) => storedPackageFacts({ tarball: () => archive } as unknown as NodeStore, catalog);
  assert.deepEqual(inspect(bytes)(CONTROLLED_OPCUA_REQUIREMENT), { packagePresent: true, integrityValid: true, approval: 'exact' });
  const changed = Buffer.from(bytes); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  assert.equal(inspect(changed)(CONTROLLED_OPCUA_REQUIREMENT).integrityValid, false);
  assert.equal(inspect(bytes)({ ...CONTROLLED_OPCUA_REQUIREMENT, version: '0.6.1' }).integrityValid, false);
  assert.equal(inspect(undefined)(CONTROLLED_OPCUA_REQUIREMENT).integrityValid, false);
  assert.equal(PROTOCOL_PACKAGE_PINS.some(pin => String(pin.module) === '@tier0/opcua-client'), false);
  assert.equal(protocolStatuses(inspect(bytes), []).find(protocol => protocol.id === 'opcua-controlled')!.ready, false);
});
