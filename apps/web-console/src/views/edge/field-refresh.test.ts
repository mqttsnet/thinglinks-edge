import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFieldRefreshTask } from './field-refresh.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('polling while a slow request is pending shares it and lets its response commit', async () => {
  const refresh = createFieldRefreshTask();
  const delay = deferred();
  let calls = 0;
  let committed = false;
  const first = refresh.run(async (current) => {
    ++calls;
    await delay.promise;
    if (current()) committed = true;
  });
  const nextPoll = refresh.run(async () => { ++calls; });
  assert.equal(nextPoll, first);
  assert.equal(calls, 1);
  delay.resolve();
  await first;
  assert.equal(committed, true);
});

test('slow instance inspection does not block independent device data refresh', async () => {
  const instances = createFieldRefreshTask();
  const devices = createFieldRefreshTask();
  const delay = deferred();
  let instanceReady = false;
  let devicesReady = false;
  const inspection = instances.run(async (current) => {
    await delay.promise;
    if (current()) instanceReady = true;
  });
  await devices.run(async () => { devicesReady = true; });
  assert.equal(devicesReady, true);
  assert.equal(instanceReady, false);
  delay.resolve();
  await inspection;
  assert.equal(instanceReady, true);
});

test('an explicit scope change supersedes a pending request and ignores its late response', async () => {
  const refresh = createFieldRefreshTask();
  const old = deferred();
  let displayed = '';
  const previous = refresh.run(async (current) => {
    await old.promise;
    if (current()) displayed = 'previous scope';
  });
  await refresh.run(async (current) => { if (current()) displayed = 'new scope'; }, true);
  old.resolve();
  await previous;
  assert.equal(displayed, 'new scope');
});

test('leaving the page invalidates pending commits and stops new refreshes', async () => {
  const refresh = createFieldRefreshTask();
  const delay = deferred();
  let commits = 0;
  const pending = refresh.run(async (current) => {
    await delay.promise;
    if (current()) ++commits;
  });
  refresh.dispose();
  delay.resolve();
  await pending;
  await refresh.run(async () => { ++commits; });
  assert.equal(commits, 0);
});

test('a failed refresh releases its slot so the next poll can retry', async () => {
  const refresh = createFieldRefreshTask();
  await assert.rejects(refresh.run(async () => { throw new Error('unavailable'); }));
  let retried = false;
  await refresh.run(async () => { retried = true; });
  assert.equal(retried, true);
});
