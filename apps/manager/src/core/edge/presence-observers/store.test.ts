import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldRegistry } from '../registry.ts';
import { openDb } from '../../db.ts';
import { PresenceObservers, PresenceObserverError } from './index.ts';

const scope = { instanceId: 'i', nodeId: 'device', observerId: 'collector-a' };
function fixture(limits: NonNullable<ConstructorParameters<typeof PresenceObservers>[1]> = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('i','I','test',512,0.5,'/red/i/','test')").run();
  let now = 1000;
  const observers = new PresenceObservers(db, { now: () => now, ...limits });
  return { db, observers, time: (value: number) => { now = value; } };
}
function activate(observers: PresenceObservers, s = scope, runNonce = 'run-a') {
  return observers.activate(s, { runNonce, ticket: observers.challenge(s, runNonce).ticket });
}
const sample = (runNonce: string, generation: number, sequence: number) => ({ kind: 'sample' as const, runNonce, generation, sequence });
const offline = (runNonce: string, generation: number, sequence: number) => ({ kind: 'status' as const, online: false as const, runNonce, generation, sequence });

test('new observers are unknown, sample commits and presence advances together, late false and old data are rejected', () => {
  const f = fixture(); try {
    const run = activate(f.observers); assert.equal(f.observers.aggregate('i', 'device'), undefined);
    let commits = 0;
    const first = f.observers.accept(scope, sample('run-a', run.generation, 2), () => { commits++; });
    assert.equal(first.accepted, true); assert.equal(first.state, true); assert.equal(first.freshData, true);
    assert.equal(f.observers.accept(scope, offline('run-a', run.generation, 1)).accepted, false);
    assert.equal(f.observers.aggregate('i', 'device'), true);
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 2), () => { commits++; }).accepted, false);
    assert.equal(commits, 1);
    assert.equal(f.observers.accept(scope, offline('run-a', run.generation, 3)).state, false);
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 2), () => { commits++; }).accepted, false);
    assert.equal(f.observers.aggregate('i', 'device'), false); assert.equal(commits, 1);
  } finally { f.db.close(); }
});

test('two collectors in one instance aggregate conservatively and one may retire without disabling its peer', () => {
  const f = fixture(); try {
    const b = { ...scope, observerId: 'collector-b' };
    const aRun = activate(f.observers), bRun = activate(f.observers, b, 'run-b');
    f.observers.accept(scope, sample('run-a', aRun.generation, 1));
    f.observers.accept(b, sample('run-b', bRun.generation, 1));
    assert.equal(f.observers.accept(scope, offline('run-a', aRun.generation, 2)).state, true);
    f.observers.markUnknown(b); assert.equal(f.observers.aggregate('i', 'device'), undefined);
    f.observers.accept(b, sample('run-b', bRun.generation, 2));
    assert.equal(f.observers.retireObserver(scope).state, true);
    assert.equal(f.observers.retireObserver(b).state, false);
  } finally { f.db.close(); }
});

test('ticket activation uses CAS; old nonce cannot get a new revision or revive after a newer activation', () => {
  const f = fixture(); try {
    const old = f.observers.challenge(scope, 'old'), next = f.observers.challenge(scope, 'new');
    const current = f.observers.activate(scope, { runNonce: 'new', ticket: next.ticket });
    assert.throws(() => f.observers.activate(scope, { runNonce: 'old', ticket: old.ticket }), PresenceObserverError);
    assert.throws(() => f.observers.challenge(scope, 'old'), PresenceObserverError);
    assert.equal(f.observers.activate(scope, { runNonce: 'new', ticket: next.ticket }).generation, current.generation);
    const newer = activate(f.observers, scope, 'newer');
    assert.ok(newer.generation > current.generation);
    assert.throws(() => f.observers.activate(scope, { runNonce: 'new', ticket: next.ticket }), PresenceObserverError);
    assert.equal(f.observers.accept(scope, sample('new', current.generation, 100)).accepted, false);
  } finally { f.db.close(); }
});

test('expired ticket renewal retains the original CAS revision and cannot steal a newer run', () => {
  const f = fixture(); try {
    const first = f.observers.challenge(scope, 'one'); f.time(40000);
    assert.throws(() => f.observers.activate(scope, { runNonce: 'one', ticket: first.ticket }), PresenceObserverError);
    const renewed = f.observers.challenge(scope, 'one');
    assert.equal(renewed.expectedRevision, first.expectedRevision); assert.notEqual(renewed.ticket, first.ticket);
    activate(f.observers, scope, 'two');
    assert.throws(() => f.observers.activate(scope, { runNonce: 'one', ticket: renewed.ticket }), PresenceObserverError);
    assert.throws(() => f.observers.challenge(scope, 'one'), PresenceObserverError);
  } finally { f.db.close(); }
});

test('recreating the service preserves run generation and sequence; explicit unknown requires a newer live event', () => {
  const f = fixture(); try {
    const run = activate(f.observers); f.observers.accept(scope, sample('run-a', run.generation, 4));
    const restarted = new PresenceObservers(f.db, { now: () => 1100 });
    assert.equal(activate(restarted).nextSequence, 5);
    restarted.markAllUnknown(); assert.equal(restarted.aggregate('i', 'device'), undefined);
    assert.equal(restarted.accept(scope, sample('run-a', run.generation, 4)).accepted, false);
    assert.equal(restarted.accept(scope, sample('run-a', run.generation, 5)).state, true);
  } finally { f.db.close(); }
});

test('stopping an instance fences all previous requests; restart handshake needs a new nonce', () => {
  const f = fixture(); try {
    const run = activate(f.observers); f.observers.accept(scope, sample('run-a', run.generation, 1));
    const stopped = f.observers.stopInstance('i'); assert.equal(stopped[0]?.state, false);
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 2)).accepted, false);
    assert.throws(() => f.observers.challenge(scope, 'run-a'), PresenceObserverError);
    f.observers.stopInstance('i');
    const next = activate(f.observers, scope, 'next'); assert.equal(next.generation, run.generation + 2);
    assert.equal(f.observers.aggregate('i', 'device'), undefined);
    assert.equal(f.observers.accept(scope, sample('next', next.generation, 1)).state, true);
  } finally { f.db.close(); }
});

test('failure or invalid async sample commit does not advance observer sequence', () => {
  const f = fixture(); try {
    const run = activate(f.observers);
    assert.throws(() => f.observers.accept(scope, sample('run-a', run.generation, 1), () => { throw new Error('sample rejected'); }));
    assert.equal(f.observers.aggregate('i', 'device'), undefined);
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 1)).accepted, true);
  } finally { f.db.close(); }
});

test('capacity rejection persists an unknown guard instead of losing an untracked peer and reporting offline', () => {
  const f = fixture({ maxObservers: 1 }); try {
    const a = activate(f.observers); f.observers.accept(scope, sample('run-a', a.generation, 1));
    assert.throws(() => f.observers.challenge({ ...scope, observerId: 'rejected-b' }, 'b'), PresenceObserverError);
    assert.equal(f.observers.aggregate('i', 'device'), true);
    assert.equal(f.observers.accept(scope, offline('run-a', a.generation, 2)).state, undefined);
    assert.equal(new PresenceObservers(f.db).aggregate('i', 'device'), undefined);
    assert.equal(f.observers.hasObservers('i', 'device'), true);
  } finally { f.db.close(); }
});

test('run tombstone capacity is bounded and invalid identities never cross instance or observer scopes', () => {
  const f = fixture({ maxRuns: 1 }); try {
    const run = activate(f.observers);
    assert.throws(() => f.observers.challenge(scope, 'second'), PresenceObserverError);
    const different = { ...scope, observerId: 'wrong' };
    assert.equal(f.observers.accept(different, sample('run-a', run.generation, 1)).accepted, false);
    for (const sequence of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => f.observers.accept(scope, sample('run-a', run.generation, sequence)), PresenceObserverError);
    }
    assert.throws(() => f.observers.challenge({ ...scope, nodeId: '' }, 'x'), PresenceObserverError);
  } finally { f.db.close(); }
});

test('heartbeat is neutral, expiry is bounded, and renewed generation rejects all previous data', () => {
  const f = fixture(); try {
    const run = activate(f.observers); f.observers.accept(scope, sample('run-a', run.generation, 4));
    f.time(2000); const renewed = f.observers.renew(scope, { runNonce: 'run-a', generation: run.generation });
    assert.equal(renewed.generation, run.generation); assert.equal(renewed.nextSequence, 5);
    assert.equal(f.observers.aggregate('i', 'device'), true);
    f.time(renewed.leaseExpiresAt + 1);
    assert.equal(f.observers.expireLeases()[0]?.state, false); assert.deepEqual(f.observers.expireLeases(), []);
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 5)).accepted, false);
    const next = f.observers.renew(scope, { runNonce: 'run-a', generation: run.generation });
    assert.equal(next.generation, run.generation + 1); assert.equal(next.nextSequence, 1);
    assert.equal(f.observers.aggregate('i', 'device'), undefined);
    const retry = f.observers.renew(scope, { runNonce: 'run-a', generation: run.generation });
    assert.deepEqual(retry, next, 'lost renewal response cannot rotate twice');
    assert.equal(f.observers.accept(scope, sample('run-a', run.generation, 999)).accepted, false);
    assert.equal(f.observers.accept(scope, sample('run-a', next.generation, 1)).state, true);
  } finally { f.db.close(); }
});

test('status cannot fabricate a positive observation and report:false samples still count as fresh data', () => {
  const f = fixture(); try {
    const run = activate(f.observers);
    assert.throws(() => f.observers.accept(scope, { ...offline('run-a', run.generation, 1), online: true } as never), PresenceObserverError);
    assert.equal(f.observers.aggregate('i', 'device'), undefined);
    const result = f.observers.accept(scope, { ...sample('run-a', run.generation, 1), report: false });
    assert.equal(result.state, true); assert.equal(result.freshData, true);
  } finally { f.db.close(); }
});

test('successful observer activity changes only its instance counter; rejected data cannot fake new activity', () => {
  const f = fixture(); try {
    assert.equal(f.observers.activityVersion('i'), 0); assert.equal(f.observers.activityVersion('j'), 0);
    const challenge = f.observers.challenge(scope, 'run-a'); assert.equal(f.observers.activityVersion('i'), 1);
    const run = f.observers.activate(scope, { runNonce: 'run-a', ticket: challenge.ticket });
    assert.equal(f.observers.activityVersion('i'), 2);
    f.observers.renew(scope, { runNonce: 'run-a', generation: run.generation });
    assert.equal(f.observers.activityVersion('i'), 3);
    f.observers.accept(scope, sample('run-a', run.generation, 1)); assert.equal(f.observers.activityVersion('i'), 4);
    f.observers.accept(scope, sample('run-a', run.generation, 1));
    f.observers.accept(scope, sample('old', run.generation, 2));
    assert.equal(f.observers.activityVersion('i'), 4); assert.equal(f.observers.activityVersion('j'), 0);
  } finally { f.db.close(); }
});

for (const budget of ['maxDevicesPerInstance', 'maxObserversPerInstance', 'maxRunsPerInstance'] as const) {
  test(`${budget} rejection stays within its instance while peers can start and existing collectors keep running`, () => {
    const f = fixture({ [budget]: 1, maxDevices: 10, maxObservers: 10, maxRuns: 10 });
    try {
      f.db.prepare("INSERT INTO instance(id,name,image_tag,mem_limit,cpu_limit,admin_root,cred_secret) VALUES('j','J','test',512,0.5,'/red/j/','test')").run();
      const own = activate(f.observers);
      const rejected = budget === 'maxDevicesPerInstance' ? { ...scope, nodeId: 'another-device' }
        : budget === 'maxObserversPerInstance' ? { ...scope, observerId: 'another-observer' } : scope;
      assert.throws(() => f.observers.challenge(rejected, 'second-run'), PresenceObserverError);
      const peerScope = { ...scope, instanceId: 'j' };
      const peer = activate(f.observers, peerScope);
      const registry = new FieldRegistry(f.db);
      registry.upsertDevice('j', { nodeId: 'device', name: 'Peer device' });
      const result = f.observers.accept(peerScope, sample('run-a', peer.generation, 1), () => {
        registry.recordValues('j', [{ nodeId: 'device', tagId: 'temperature', value: 26 }], { updateOnline: false });
      });
      assert.equal(result.accepted, true); assert.equal(result.state, true);
      assert.equal(registry.tags('j', 'device')[0]?.lastValue, 26);
      assert.equal(f.observers.accept(peerScope, offline('run-a', peer.generation, 2)).state, false, 'A cannot set the unknown-source guard on B');
      assert.equal(f.observers.renew(scope, { runNonce: 'run-a', generation: own.generation }).generation, own.generation);
      assert.equal(f.observers.accept(scope, sample('run-a', own.generation, 1)).accepted, true, 'existing work is not rejected by new-start quotas');
    } finally { f.db.close(); }
  });
}
