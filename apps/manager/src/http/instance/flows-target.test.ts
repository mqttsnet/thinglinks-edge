import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstanceAdminRuntime } from '../../core/instance/admin-runtime.ts';
import { InstanceAdminRuntimeError } from '../../core/instance/admin-runtime.ts';
import type { HttpContext } from '../context.ts';
import { targetFor } from './flows-target.ts';

test('HTTP target adapter delegates to the shared core Admin runtime object', () => {
  const target = {
    upstream: 'http://instance:1880', adminRoot: '/red/line-a/',
    username: 'admin', password: 'secret',
  };
  const calls: string[] = [];
  const adminRuntime: InstanceAdminRuntime = {
    target: (id) => { calls.push(id); return target; },
    waitReady: async () => undefined,
  };
  const ctx = { adminRuntime } as unknown as HttpContext;

  assert.strictEqual(targetFor(ctx, 'line-a'), target);
  assert.deepEqual(calls, ['line-a']);
});

for (const [reason, code] of [
  ['instance-not-found', 404],
  ['credential-not-found', 500],
] as const) {
  test(`HTTP target adapter maps ${reason} without rebuilding credentials`, () => {
    const adminRuntime: InstanceAdminRuntime = {
      target: () => { throw new InstanceAdminRuntimeError(reason, 'controlled core error'); },
      waitReady: async () => undefined,
    };
    assert.deepEqual(
      targetFor({ adminRuntime } as unknown as HttpContext, 'line-a'),
      { error: 'controlled core error', code },
    );
  });
}
