import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOOP_PLATFORM_NODE_BARRIER } from './platform-operation-barrier.ts';

test('production platform operation barrier is an object-only no-op', async () => {
  assert.equal(typeof NOOP_PLATFORM_NODE_BARRIER, 'object');
  assert.equal(Object.isFrozen(NOOP_PLATFORM_NODE_BARRIER), true);
  await assert.doesNotReject(() => NOOP_PLATFORM_NODE_BARRIER.reach({
    instanceId: 'line-a',
    txId: 'tx-bootstrap-a',
    phase: 'preparing',
    sequence: 1,
    boundary: 'after-phase-persist',
  }));
});
