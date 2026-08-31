import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tarArchive } from '../archive/tar.ts';
import { UpstreamRegistry, assertIntegrity } from './upstream.ts';
import { NodePolicyError } from './policy.ts';

const pack = (name: string, version: string) => gzipSync(tarArchive([{
  name: 'package/package.json', content: JSON.stringify({ name, version }),
}]));

const sri = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

/** 造一个只认两条路径的假上游 */
function fakeUpstream(pkgs: Record<string, { version: string; body: Buffer }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    for (const [name, p] of Object.entries(pkgs)) {
      if (u.endsWith(`/${encodeURIComponent(name)}`)) {
        return new Response(JSON.stringify({
          name, 'dist-tags': { latest: p.version },
          versions: { [p.version]: {
            name, version: p.version,
            dist: { tarball: `https://up.example/${name}.tgz`, integrity: sri(p.body) },
          } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u === `https://up.example/${name}.tgz`) {
        return new Response(p.body, { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('没有启用中的源即不启用 —— 纯离线现场就是这个形态', () => {
  assert.equal(new UpstreamRegistry({ sources: () => [] }).enabled, false);
});

test('取得到 packument', async () => {
  const body = pack('a-node', '1.0.0');
  const { impl } = fakeUpstream({ 'a-node': { version: '1.0.0', body } });
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  const doc = await up.packument('a-node');
  assert.equal(doc?.name, 'a-node');
  assert.ok(doc?.versions['1.0.0']);
});

test('上游没有这个包回 undefined —— 与「连不上」是两回事', async () => {
  const { impl } = fakeUpstream({});
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  assert.equal(await up.packument('nope-node'), undefined);
});

test('连不上要抛错，不能伪装成「包不存在」', async () => {
  // 两者对现场是完全不同的事：一个查网络，一个查名字拼写
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  await assert.rejects(() => up.packument('a-node'), /所有节点源都取不到/);
});

test('packument 有短期缓存，一次安装里不重复问', async () => {
  const body = pack('a-node', '1.0.0');
  const { impl, calls } = fakeUpstream({ 'a-node': { version: '1.0.0', body } });
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  await up.packument('a-node');
  await up.packument('a-node');
  assert.equal(calls.filter((c) => c.endsWith('/a-node')).length, 1);
});

test('取包体并校验通过', async () => {
  const body = pack('a-node', '1.0.0');
  const { impl } = fakeUpstream({ 'a-node': { version: '1.0.0', body } });
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  assert.deepEqual(await up.tarball('a-node', '1.0.0'), body);
});

test('上游没有该版本回 undefined', async () => {
  const body = pack('a-node', '1.0.0');
  const { impl } = fakeUpstream({ 'a-node': { version: '1.0.0', body } });
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  assert.equal(await up.tarball('a-node', '9.9.9'), undefined);
});

test('**校验值对不上必须拒绝入库** —— 一次坏下载会永久污染本地库', async () => {
  const good = pack('a-node', '1.0.0');
  const bad = pack('a-node', '1.0.0-tampered');
  const impl = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/a-node')) {
      return new Response(JSON.stringify({
        name: 'a-node', versions: { '1.0.0': {
          dist: { tarball: 'https://up.example/a.tgz', integrity: sri(good) },
        } },
      }), { status: 200 });
    }
    return new Response(bad, { status: 200 });   // 给的内容与声明不符
  }) as unknown as typeof fetch;
  const up = new UpstreamRegistry({ sources: () => [{ name: 'up', url: 'https://up.example' }], fetchImpl: impl });
  await assert.rejects(() => up.tarball('a-node', '1.0.0'), /校验失败/);
});

test('校验值本身：integrity 与 shasum 两种都认', () => {
  const b = Buffer.from('hello');
  assert.doesNotThrow(() => assertIntegrity('m', '1', b, sri(b)));
  assert.throws(() => assertIntegrity('m', '1', b, 'sha512-AAAA'), NodePolicyError);
  const sha1 = createHash('sha1').update(b).digest('hex');
  assert.doesNotThrow(() => assertIntegrity('m', '1', b, undefined, sha1));
  assert.throws(() => assertIntegrity('m', '1', b, undefined, 'deadbeef'), NodePolicyError);
});

test('上游没给校验值时放行 —— 少数私服确实不返回，一律拒会让那些现场彻底装不上', () => {
  assert.doesNotThrow(() => assertIntegrity('m', '1', Buffer.from('x')));
});

// ── 多源与搜索 ──────────────────────────────────────────

/** 一个只认搜索接口的假源 */
function searchSource(name: string, names: string[]) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (!u.includes('/-/v1/search')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({
      objects: names.map((n) => ({
        package: { name: n, version: '1.0.0', description: `${name} 的 ${n}`, keywords: ['node-red'], date: '2026-01-01' },
      })),
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('搜索加 keywords:node-red 限定 —— 不加会返回一堆无关的普通库', async () => {
  let seen = '';
  const impl = (async (url: string | URL) => {
    seen = String(url);
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const up = new UpstreamRegistry({
    sources: () => [{ name: 'x', url: 'https://up.example' }], fetchImpl: impl,
  });
  await up.search('modbus');
  assert.match(decodeURIComponent(seen), /keywords:node-red modbus/);
});

test('空关键字不发请求', async () => {
  let called = false;
  const impl = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const up = new UpstreamRegistry({
    sources: () => [{ name: 'x', url: 'https://up.example' }], fetchImpl: impl,
  });
  assert.deepEqual(await up.search('   '), []);
  assert.equal(called, false);
});

test('多源结果合并，同名包按源的顺序取先到的那个', async () => {
  const up = new UpstreamRegistry({
    sources: () => [
      { name: '内网', url: 'https://a.example' },
      { name: '公网', url: 'https://b.example' },
    ],
    fetchImpl: (async (url: string | URL) => {
      const u = String(url);
      const which = u.startsWith('https://a.example') ? '内网' : '公网';
      const names = which === '内网' ? ['dup-node', 'only-a'] : ['dup-node', 'only-b'];
      return searchSource(which, names)(url);
    }) as unknown as typeof fetch,
  });
  const hits = await up.search('x');
  assert.deepEqual(hits.map((h) => h.name).sort(), ['dup-node', 'only-a', 'only-b']);
  assert.equal(hits.find((h) => h.name === 'dup-node')?.source, '内网');
});

test('**一个源挂了不拖垮整次搜索** —— 现场常有内网源临时不通', async () => {
  const up = new UpstreamRegistry({
    sources: () => [
      { name: '坏源', url: 'https://dead.example' },
      { name: '好源', url: 'https://ok.example' },
    ],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).startsWith('https://dead.example')) throw new Error('ECONNREFUSED');
      return searchSource('好源', ['a-node'])(url);
    }) as unknown as typeof fetch,
  });
  assert.deepEqual((await up.search('a')).map((h) => h.name), ['a-node']);
});

test('源清单是现读的 —— 页面上加了源立刻生效，不必重启', async () => {
  let list: Array<{ name: string; url: string }> = [];
  const up = new UpstreamRegistry({ sources: () => list, fetchImpl: searchSource('s', ['a-node']) });
  assert.equal(up.enabled, false);
  list = [{ name: 's', url: 'https://up.example' }];
  assert.equal(up.enabled, true);
  assert.equal((await up.search('a')).length, 1);
});

test('全部源都 404 = 包不存在；有源连不上 = 抛错。两者不能混', async () => {
  const notFound = new UpstreamRegistry({
    sources: () => [{ name: 'a', url: 'https://a.example' }],
    fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(await notFound.packument('nope'), undefined);

  const broken = new UpstreamRegistry({
    sources: () => [{ name: 'a', url: 'https://a.example' }],
    fetchImpl: (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch,
  });
  await assert.rejects(() => broken.packument('a-node'), /所有节点源都取不到/);
});
