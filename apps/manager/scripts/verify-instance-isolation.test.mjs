import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  parseIsolationArgs, assertTemporaryManager, buildIsolationFlows,
  assessNetworkProbe, assessRuntimeProbe, runtimeProbeScript, recoverUncertainResources,
} from './verify-instance-isolation.mjs';

test('isolation verifier requires explicit task-owned parameters and bounded load', () => {
  assert.deepEqual(parseIsolationArgs(['--help']), { help: true });
  assert.throws(() => parseIsolationArgs(['--run']), /missing/);
  const args = ['--run', '--node-red-image', 'nodered/node-red:5.0.4-24-minimal', '--manager-container', 'a'.repeat(64),
    '--manager-owner', 'verifier.owner=fixture-one', '--manager-url', 'http://fixture-manager:19100',
    '--policy-url', 'http://fixture-policy:2375', '--data-root', '/private/tmp/fixture-data',
    '--network-prefix', 'fixture-net', '--report', '/private/tmp/isolation-result.json'];
  const options = parseIsolationArgs(args);
  assert.equal(options.loadMs, 10000);
  assert.equal(options.loadBytes, 8 * 1024 ** 2);
  assert.throws(() => parseIsolationArgs([...args, '--load-ms', '60000']), /10000/);
  assert.throws(() => parseIsolationArgs([...args, '--load-bytes', String(64 * 1024 ** 2)]), /8 MiB/);
  assert.throws(() => parseIsolationArgs([...args, '--data-root', '/']), /root/);
  assert.throws(() => parseIsolationArgs([...args, '--manager-url', 'http://user:secret@fixture-manager']), /credentials/);
});

test('provided Manager must match immutable ID and explicit fixture ownership', () => {
  const options = { managerContainer: 'a'.repeat(64), managerOwner: ['verifier.owner', 'fixture-one'] };
  const fixture = { Id: 'a'.repeat(64), Name: '/tle-verifier-manager-one', Config: { Labels: { 'verifier.owner': 'fixture-one' } }, State: { Running: true } };
  assert.equal(assertTemporaryManager(fixture, options), fixture);
  assert.throws(() => assertTemporaryManager({ ...fixture, Name: '/thinglinks-edge-manager' }, options), /production/);
  assert.throws(() => assertTemporaryManager({ ...fixture, Id: 'b'.repeat(64) }, options), /identity/);
  assert.throws(() => assertTemporaryManager({ ...fixture, Config: { Labels: {} } }, options), /ownership/);
});

test('runtime probe fails closed and distinguishes missing shadow from write denial', () => {
  const fixture = { uid: 1000, gid: 1000, capEff: '0000000000000000', noNewPrivs: '1', shadowExists: true,
    shadowWritable: false, rootWriteDenied: true, dockerSocketExists: false, siblingReadable: false, ownSentinelReadable: true };
  assert.equal(assessRuntimeProbe(fixture), true);
  for (const patch of [{ uid: 0 }, { shadowExists: false }, { shadowWritable: true }, { siblingReadable: true }, { dockerSocketExists: true }, { rootWriteDenied: false }]) {
    assert.equal(assessRuntimeProbe({ ...fixture, ...patch }), false);
  }
});

test('a reachable sibling published port or host service cannot count as isolation success', () => {
  assert.equal(assessNetworkProbe({ connected: false, error: 'ETIMEDOUT' }), 'pass');
  assert.equal(assessNetworkProbe({ connected: true }), 'fail');
  assert.equal(assessNetworkProbe({ connected: false, error: 'ENOTFOUND' }), 'unverified');
  assert.equal(assessNetworkProbe({ error: 'EFAIL' }), 'unverified');
});

test('fixture uses genuine Node-RED HTTP collection, calculation and report nodes', () => {
  const flows = buildIsolationFlows({ role: 'b', adminRoot: '/red/fixture-b/', fixtureUrl: 'http://fixture-protocol:1881', fixtureKey: 'fake-fixture-key', loadMs: 10000, loadBytes: 8 * 1024 ** 2 });
  const types = flows.map(node => node.type);
  assert.ok(types.includes('inject') && types.includes('function'));
  assert.equal(types.filter(type => type === 'http request').length, 2);
  assert.ok(flows.some(node => node.type === 'http request' && node.method === 'GET' && node.url.endsWith('/sample')));
  assert.ok(flows.some(node => node.type === 'http request' && node.method === 'POST' && node.url.endsWith('/ingest')));
  assert.ok(flows.some(node => node.type === 'tcp in'));
  const load = buildIsolationFlows({ role: 'a', adminRoot: '/red/fixture-a/', fixtureUrl: 'http://fixture-protocol:1881', fixtureKey: 'fake-fixture-key', loadMs: 1000, loadBytes: 1024 });
  assert.ok(load.some(node => node.type === 'http in' && node.method === 'post' && node.url === '/verify/load'));
  assert.ok(load.every(node => !['exec', 'python'].includes(node.type)));
});


test('generated process probe reads Linux status correctly without reading password contents', () => {
  let result;
  const fakeFs = {
    constants: { W_OK: 2 },
    readFileSync(path) {
      if (path === '/proc/self/status') return 'Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n';
      if (path === '/data/isolation-sentinel') return 'sentinel:fixture:a';
      if (path === '/etc/shadow') throw new Error('probe must never read shadow contents');
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    accessSync() { throw Object.assign(new Error('forbidden'), { code: 'EACCES' }); },
    existsSync(path) { return path === '/etc/shadow'; },
    writeFileSync() { throw Object.assign(new Error('read only'), { code: 'EROFS' }); },
  };
  runInNewContext(runtimeProbeScript({ invocation: '012345abcdef', siblingPath: '/tmp/fixture/b/isolation-sentinel', siblingId: 'fixture-b' }), {
    require: () => fakeFs, process: { getuid: () => 1000, getgid: () => 1000 }, console: { log: value => { result = JSON.parse(value); } },
  });
  assert.equal(result.capEff, '0000000000000000');
  assert.equal(result.noNewPrivs, '1');
  assert.equal(assessRuntimeProbe(result), true);
});


test('lost create responses recover only exact new names and invocation ownership', async () => {
  const planned = [{ kind: 'network', name: 'fixture-a', labels: { owner: 'this-invocation' } }];
  const seen = [];
  const inventory = { networks: [{ id: 'old-network' }], containers: [] };
  const own = { Id: 'new-network', Name: 'fixture-a', Labels: { owner: 'this-invocation' } };
  const good = await recoverUncertainResources(planned, [], async () => own, async (...args) => seen.push(args), inventory);
  assert.equal(good.recovered.length, 1);
  assert.equal(good.failures.length, 0);
  assert.equal(seen[0][3], 'new-network');
  for (const changed of [{ ...own, Id: 'old-network' }, { ...own, Labels: { owner: 'another-run' } }, { ...own, Name: 'production' }]) {
    const rejected = await recoverUncertainResources(planned, [], async () => changed, async () => assert.fail('must not capture unowned resource'), inventory);
    assert.equal(rejected.recovered.length, 0);
    assert.equal(rejected.failures.length, 1);
  }
});
