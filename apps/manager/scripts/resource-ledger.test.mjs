import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileAbsentResources } from './_resource-ledger.mjs';

function inventory(initial = []) {
  const resources = new Map(initial.map((resource) => [resource.Id, resource]));
  return {
    resources,
    async inspectById(id) { return resources.get(id); },
    async inspectByName(name) {
      return [...resources.values()].find((resource) => resource.Name === name);
    },
  };
}

test('reconciles a stale ledger after the API deleted a resource but its HTTP response failed', async () => {
  const ledger = new Map([['owned-container', 'container-id']]);
  const bed = inventory([{ Id: 'container-id', Name: 'owned-container' }]);
  const deleteWithLostResponse = async () => {
    bed.resources.delete('container-id');
    throw new Error('HTTP response connection reset');
  };
  await assert.rejects(deleteWithLostResponse(), /connection reset/);

  await reconcileAbsentResources(ledger, bed, 'container');

  assert.equal(ledger.size, 0);
  assert.equal(bed.resources.size, 0);
});

test('reconciles a resource that disappeared after list but before cleanup inspection', async () => {
  const ledger = new Map([['owned-network', 'network-id']]);
  const bed = inventory([{ Id: 'network-id', Name: 'owned-network' }]);
  const listed = [...bed.resources.values()];
  bed.resources.delete('network-id');
  assert.equal(listed.length, 1);
  assert.equal(await bed.inspectById(listed[0].Id), undefined);

  await reconcileAbsentResources(ledger, bed, 'network');

  assert.equal(ledger.size, 0);
});

test('retains a same-name replacement and reports the recorded identity', async () => {
  const ledger = new Map([['owned-network', 'old-id']]);
  const replacement = { Id: 'foreign-id', Name: 'owned-network' };
  const bed = inventory([replacement]);

  await assert.rejects(
    reconcileAbsentResources(ledger, bed, 'network'),
    /network.*owned-network.*old-id.*name.*exists/i,
  );

  assert.deepEqual([...ledger], [['owned-network', 'old-id']]);
  assert.equal(bed.resources.get('foreign-id'), replacement);
});

test('retains the recorded id when that resource exists under a different name', async () => {
  const ledger = new Map([['original-name', 'old-id']]);
  const renamed = { Id: 'old-id', Name: 'different-name' };
  const bed = inventory([renamed]);

  await assert.rejects(
    reconcileAbsentResources(ledger, bed, 'container'),
    /container.*original-name.*old-id.*id.*exists/i,
  );

  assert.deepEqual([...ledger], [['original-name', 'old-id']]);
  assert.equal(bed.resources.get('old-id'), renamed);
});

test('retains an unchanged live resource instead of deleting it', async () => {
  const ledger = new Map([['owned-container', 'container-id']]);
  const existing = { Id: 'container-id', Name: 'owned-container' };
  const bed = inventory([existing]);

  await assert.rejects(reconcileAbsentResources(ledger, bed, 'container'), /exists/);

  assert.deepEqual([...ledger], [['owned-container', 'container-id']]);
  assert.equal(bed.resources.get('container-id'), existing);
});

for (const [operation, cause] of [
  ['inspectById', Object.assign(new Error('daemon unavailable'), { statusCode: 500 })],
  ['inspectByName', Object.assign(new Error('socket permission denied'), { code: 'EACCES' })],
]) {
  test(`retains the ledger on ${operation} failure instead of treating it as absence`, async () => {
    const ledger = new Map([['owned-container', 'container-id']]);
    const bed = inventory();
    bed[operation] = async () => { throw cause; };

    await assert.rejects(
      reconcileAbsentResources(ledger, bed, 'container'),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /owned-container.*container-id/);
        assert.ok(error.message.includes(cause.message));
        assert.equal(error.errors[0].cause, cause);
        return true;
      },
    );

    assert.deepEqual([...ledger], [['owned-container', 'container-id']]);
  });
}

test('only explicit undefined inspection results prove absence', async () => {
  const ledger = new Map([['owned-container', 'container-id']]);

  await assert.rejects(reconcileAbsentResources(ledger, {
    async inspectById() { return undefined; },
    async inspectByName() { return null; },
  }, 'container'), /exists/);

  assert.deepEqual([...ledger], [['owned-container', 'container-id']]);
});

test('continues reconciling other entries while aggregating failures', async () => {
  const ledger = new Map([
    ['live-container', 'live-id'],
    ['gone-container', 'gone-id'],
    ['replaced-container', 'replaced-id'],
  ]);
  const bed = inventory([
    { Id: 'live-id', Name: 'live-container' },
    { Id: 'foreign-id', Name: 'replaced-container' },
  ]);

  await assert.rejects(reconcileAbsentResources(ledger, bed, 'container'), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /live-container/);
    assert.match(error.message, /replaced-container/);
    return true;
  });

  assert.deepEqual([...ledger], [
    ['live-container', 'live-id'],
    ['replaced-container', 'replaced-id'],
  ]);
  assert.equal(bed.resources.size, 2);
});

test('retains a new ledger identity recorded while the old identity is being inspected', async () => {
  const ledger = new Map([['owned-container', 'old-id']]);

  await assert.rejects(reconcileAbsentResources(ledger, {
    async inspectById() { return undefined; },
    async inspectByName() {
      ledger.set('owned-container', 'new-id');
      return undefined;
    },
  }, 'container'), /ledger.*changed/i);

  assert.deepEqual([...ledger], [['owned-container', 'new-id']]);
});

test('reports non-Error inspection failures and still reconciles later absent entries', async () => {
  const ledger = new Map([['failed-container', 'failed-id'], ['gone-container', 'gone-id']]);

  await assert.rejects(reconcileAbsentResources(ledger, {
    async inspectById(id) {
      if (id === 'failed-id') throw null;
      return undefined;
    },
    async inspectByName() { return undefined; },
  }, 'container'), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].cause, null);
    return true;
  });

  assert.deepEqual([...ledger], [['failed-container', 'failed-id']]);
});
