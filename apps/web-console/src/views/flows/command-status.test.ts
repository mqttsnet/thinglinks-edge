import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandStatus, commandReplyStatus } from './command-status.ts';
import type { EdgeCommandRecord } from '../../api/types.ts';
const command = (overrides: Partial<EdgeCommandRecord> = {}): EdgeCommandRecord => ({
  id: '1', mid: 'm1', gatewayId: 'gw', instanceId: 'line-fixture', consumerId: 'device', deviceIdentification: 'meter', serviceCode: 'power', cmd: 'set', params: {}, status: 'queued', result: null, error: '', createdAt: '2026-09-09T00:00:00Z', completedAt: null, replyPending: false, replyAttempts: 0, replyError: '', ...overrides,
});
test('execution timeout is unknown rather than a retryable failure or success', () => {
  const state = commandStatus('unknown');
  assert.match(state.label, /结果未知/); assert.notEqual(state.type, 'success');
});
test('queued command does not claim receipt delivery and a published receipt never claims cloud completion', () => {
  assert.equal(commandReplyStatus(command()).label, '等待执行结果');
  const published = commandReplyStatus(command({ status: 'succeeded', completedAt: '2026-09-09T00:00:01Z' }));
  assert.match(published.label, /已发布/); assert.match(published.hint, /云端.*未确认/);
  assert.match(commandReplyStatus(command({ status: 'failed', replyPending: true, replyError: 'offline' })).label, /待重试/);
});
