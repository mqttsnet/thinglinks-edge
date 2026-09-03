import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { openDb } from '../db.ts';
import { deriveKey } from '../auth/crypto.ts';
import { InstanceRepo } from './repo.ts';
import {
  InstanceAdminRuntimeError,
  RepositoryInstanceAdminRuntime,
} from './admin-runtime.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function repoWithInstance() {
  const repo = new InstanceRepo(openDb(':memory:'), deriveKey('admin-runtime-test', 'instance'));
  repo.create({
    id: 'line-a', name: 'Line A', imageTag: '5.0.4-24-minimal',
    memLimit: 512, cpuLimit: 0.5, adminRoot: '/red/line-a/',
    credSecret: 'credential-secret', notes: '', nodeRuntimeMode: 'npm',
  }, [], [{ username: 'admin', password: 'decrypted-password', permissions: '*' }]);
  return repo;
}

test('target uses the persisted admin root and first decrypted credential', () => {
  const repo = repoWithInstance();
  const runtime = new RepositoryInstanceAdminRuntime({
    repo,
    upstreamFor: (id) => `http://instance-${id}:1880`,
  });
  assert.deepEqual(runtime.target('line-a'), {
    upstream: 'http://instance-line-a:1880',
    adminRoot: '/red/line-a/',
    username: 'admin',
    password: 'decrypted-password',
  });
});

test('target exposes typed core errors without embedding credentials', () => {
  const repo = repoWithInstance();
  const runtime = new RepositoryInstanceAdminRuntime({ repo, upstreamFor: () => 'http://unused' });
  assert.throws(
    () => runtime.target('line-missing'),
    (error: unknown) => {
      assert.ok(error instanceof InstanceAdminRuntimeError);
      assert.equal(error.reason, 'instance-not-found');
      assert.doesNotMatch(error.message, /decrypted-password/);
      return true;
    },
  );
});

test('waitReady polls the bounded Admin API until credentials are accepted', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    if (!req.url?.endsWith('/auth/token')) return res.writeHead(404).end();
    if (attempts === 1) return res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"access_token":"ready-token"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runtime = new RepositoryInstanceAdminRuntime({
    repo: repoWithInstance(),
    upstreamFor: () => `http://127.0.0.1:${address.port}`,
  });

  await runtime.waitReady('line-a', { timeoutMs: 500, intervalMs: 10 });
  assert.equal(attempts, 2);
});

test('waitReady aborts hanging Admin attempts at the caller deadline', async () => {
  const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const runtime = new RepositoryInstanceAdminRuntime({
    repo: repoWithInstance(),
    upstreamFor: () => 'http://hanging.invalid',
    fetchImpl: hangingFetch,
  });
  const started = Date.now();
  await assert.rejects(
    () => runtime.waitReady('line-a', { timeoutMs: 40, intervalMs: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof InstanceAdminRuntimeError);
      assert.equal(error.reason, 'readiness-timeout');
      assert.doesNotMatch(error.message, /decrypted-password/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 300);
});
