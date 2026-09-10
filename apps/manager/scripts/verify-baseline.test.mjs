import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { anonymousRouteReason, scanRouteAuthentication } from './verify-baseline.mjs';

const commands = resolve(import.meta.dirname, '../src/http/edge/commands.ts');
const scan = (text) => scanRouteAuthentication(text, commands).map(({ path, auth }) => ({ path, auth }));
const route = (path, body, method = 'post') =>
  `api.${method}(\`\${base}${path}\`, async (request, reply) => { ${body} });`;

test('recognizes the real per-instance ingest helper on every command route', () => {
  assert.deepEqual(scan(readFileSync(commands, 'utf8')), [
    { path: '/api/edge/command-bindings', auth: 'token' },
    { path: '/api/edge/commands/next', auth: 'token' },
    { path: '/api/edge/commands/:id/result', auth: 'token' },
    { path: '/api/commands', auth: 'guard' },
  ]);
});

test('does not borrow a guard from the next route or a call after the handler', () => {
  assert.deepEqual(scan(
    route('/open', 'return reply.send({ ok: true });')
    + route('/closed', 'return ctx.guard(request, reply);')
    + route('/also-open', 'return reply.send({ ok: true });')
    + 'ctx.guard(request, reply);',
  ), [
    { path: '/open', auth: 'none' },
    { path: '/closed', auth: 'guard' },
    { path: '/also-open', auth: 'none' },
  ]);
});

test('comments, strings and uncalled nested functions cannot supply authentication', () => {
  assert.deepEqual(scan(route('/open', `
    // guard(request, reply);
    const text = 'authed(request, reply)';
    const fake = () => { currentUser(request); canInstance(user, id); };
    return reply.send({ text });
  `)), [{ path: '/open', auth: 'none' }]);
});

test('only the imported ingest-auth helper counts, including an import alias', () => {
  assert.deepEqual(scan(
    "import { ingestInstance as identity } from './ingest-auth.ts';"
    + route('/token', 'const id = identity(ctx.repo, request, reply); if (!id) return;'),
  ), [{ path: '/token', auth: 'token' }]);
  for (const prefix of [
    '',
    "import { ingestInstance } from './unrelated.ts';",
    "import type { ingestInstance } from './ingest-auth.ts';",
    "const ingestInstance = () => 'forged';",
  ]) {
    assert.deepEqual(scan(prefix + route('/open',
      'const id = ingestInstance(ctx.repo, request, reply); if (!id) return;')),
    [{ path: '/open', auth: 'none' }], prefix);
  }
});

test('a local shadow of the imported helper is not trusted', () => {
  assert.deepEqual(scan(
    "import { ingestInstance } from './ingest-auth.ts';"
    + route('/open', `
      const ingestInstance = () => 'forged';
      const id = ingestInstance(ctx.repo, request, reply); if (!id) return;
    `),
  ), [{ path: '/open', auth: 'none' }]);
});

test('scans the complete handler, PATCH and static paths while retaining manual auth', () => {
  assert.deepEqual(scan(
    route('/late-guard', `const padding = '${'x'.repeat(800)}'; return fieldGuard(request, reply);`, 'patch')
    + route('/manual', 'const user = currentUser(request); if (!canInstance(user, id)) return;', 'get')
    + "app.get('/healthz', async () => ({ ok: true }));",
  ), [
    { path: '/late-guard', auth: 'guard' },
    { path: '/manual', auth: 'manual' },
    { path: '/healthz', auth: 'none' },
  ]);
});

test('the product scope has a public branding GET and an authenticated release POST', () => {
  const filename = resolve(import.meta.dirname, '../src/http/product.ts');
  const routes = scanRouteAuthentication(readFileSync(filename, 'utf8'), filename);
  assert.deepEqual(routes, [
    { method: 'get', path: '/api/product', auth: 'none' },
    { method: 'post', path: '/api/product/releases', auth: 'guard' },
  ]);
  assert.ok(anonymousRouteReason(routes[0]).length > 12);
  assert.equal(anonymousRouteReason(routes[1]), undefined);
});

test('scope routes cannot borrow a following guard, and branding anonymity is GET only', () => {
  const routes = scanRouteAuthentication((
    route('/api/product', 'return reply.send({ product });', 'get')
    + route('/api/product', 'return reply.send({ ok: true });')
    + route('/api/product/releases', 'return reply.send({ releases: [] });')
    + route('/api/closed', 'return ctx.guard(request, reply);')
  ).replaceAll('api.', 'scope.'), commands);
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.filter((item) => item.auth === 'none' && !anonymousRouteReason(item)), [
    { method: 'post', path: '/api/product', auth: 'none' },
    { method: 'post', path: '/api/product/releases', auth: 'none' },
  ]);
  for (const method of ['post', 'put', 'patch', 'delete', 'head', 'options']) {
    assert.equal(anonymousRouteReason({ path: '/api/product', method }), undefined, method);
  }
});
