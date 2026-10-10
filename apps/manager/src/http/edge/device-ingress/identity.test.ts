import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBuiltinTemplate } from '../../../core/flows/templates/catalog.ts';
import { validateManagedHttpFlow } from './flow.ts';
import { deviceIdentity } from './protocol.ts';

test('device identity accepts the same 128-character identifiers as the actual HTTP template', () => {
  for (const id of ['meter.a', 'meter:a', '_meter', 'a'.repeat(65), 'a'.repeat(128)]) {
    const template = renderBuiltinTemplate('builtin:http-receive', { nodeId: id, serviceCode: 'telemetry' });
    assert.ok(template);
    assert.doesNotThrow(() => validateManagedHttpFlow({ rev: 'r1', flows: template.flows }, '/red/i/', '/red/i/api/devices/report', id));
    assert.equal(deviceIdentity(id), id);
  }
  for (const id of ['a'.repeat(129), '-meter', 'a/b', 'a\nb', '', 123]) assert.throws(() => deviceIdentity(id));
});
