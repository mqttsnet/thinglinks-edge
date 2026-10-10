import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenerConflicts } from './listeners.ts';
import type { FlowNode } from './types.ts';
const http = (id: string, url: string, method = 'post'): FlowNode => ({ id, type: 'http in', z: 'flow', name: id, url, method });

test('HTTP static paths use the native default case-insensitive matching when checking duplicates', () => {
  const incoming = [http('incoming', '/Devices/Report/')];
  const issues = listenerConflicts([http('existing', '/devices/report')], incoming);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /HTTP 路径/);
  assert.equal(incoming[0]!.url, '/Devices/Report/', 'validation must not rewrite the user route');
});

test('HTTP conflict matching retains method and disabled-flow boundaries', () => {
  const incoming = [http('incoming', '/Devices/Report')];
  assert.equal(listenerConflicts([http('get', '/devices/report', 'get')], incoming).length, 0);
  assert.equal(listenerConflicts([http('all', '/devices/report', 'all')], incoming).length, 1);
  assert.equal(listenerConflicts([{ ...http('disabled', '/devices/report'), d: true }], incoming).length, 0);
  assert.equal(listenerConflicts([{ id: 'flow', type: 'tab', disabled: true }, http('disabled-tab', '/devices/report')], incoming).length, 0);
  assert.equal(listenerConflicts([http('other', '/devices/reports')], incoming).length, 0);
});

test('network port conflict handling remains separated by TCP and UDP', () => {
  const tcp = { id: 'tcp', type: 'tcp in', server: 'server', port: '502' };
  const udp = { id: 'udp', type: 'udp in', port: '502' };
  assert.equal(listenerConflicts([tcp], [{ ...tcp, id: 'another' }]).length, 1);
  assert.equal(listenerConflicts([udp], [{ ...udp, id: 'another' }]).length, 1);
  assert.equal(listenerConflicts([tcp], [udp]).length, 0);
});
