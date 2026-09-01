import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tarArchive } from '../archive/tar.ts';
import { UpstreamRegistry, assertIntegrity, type UpstreamPackument } from './upstream.ts';
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

const edgeDoc: UpstreamPackument = {
  name: '@mqttsnet/thinglinks-edge-nodes',
  'dist-tags': { latest: '0.0.1' },
  versions: {
    '0.0.1': {
      name: '@mqttsnet/thinglinks-edge-nodes',
      version: '0.0.1',
      description: 'ThingLinks Edge nodes',
      keywords: ['thinglinks', 'node-red'],
      'node-red': { nodes: { 'tl-device': 'tl-device.js' } },
      dist: { tarball: 'https://up.example/edge.tgz' },
    },
  },
};

function registryReturning(doc: UpstreamPackument): UpstreamRegistry {
  return new UpstreamRegistry({
    sources: () => [{ name: 'npm', url: 'https://up.example' }],
    fetchImpl: (async (url: string | URL) => String(url).includes('/-/v1/search')
      ? new Response(JSON.stringify({ objects: [] }), { status: 200 })
      : new Response(JSON.stringify(doc), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
}

test('exact scoped node package bypasses npm search index', async () => {
  const up = registryReturning(edgeDoc);
  const hits = await up.search('@mqttsnet/thinglinks-edge-nodes');
  assert.deepEqual(hits.map((hit) => [hit.name, hit.version]), [
    ['@mqttsnet/thinglinks-edge-nodes', '0.0.1'],
  ]);
});

test('exact common package is not a Node-RED search hit', async () => {
  const up = registryReturning({
    name: '@mqttsnet/thinglinks-node-red-common',
    'dist-tags': { latest: '0.0.1' },
    versions: {
      '0.0.1': {
        name: '@mqttsnet/thinglinks-node-red-common',
        version: '0.0.1',
        keywords: [],
      },
    },
  });
  assert.deepEqual(await up.search('@mqttsnet/thinglinks-node-red-common'), []);
});

test('all-source exact 404 falls through to fuzzy search', async () => {
  let fuzzyCalls = 0;
  const up = new UpstreamRegistry({
    sources: () => [{ name: 'npm', url: 'https://up.example' }],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).includes('/-/v1/search')) {
        fuzzyCalls++;
        return new Response(JSON.stringify({ objects: [{ package: {
          name: edgeDoc.name, version: '0.0.1', description: 'ThingLinks Edge nodes',
          keywords: ['thinglinks', 'node-red'],
        } }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual((await up.search('thinglinks')).map((hit) => hit.name), [edgeDoc.name]);
  assert.equal(fuzzyCalls, 1);
});

test('an exact source failure does not mask a later exact node package', async () => {
  const up = new UpstreamRegistry({
    sources: () => [
      { name: 'timeout', url: 'https://timeout.example' },
      { name: 'npm', url: 'https://up.example' },
    ],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).startsWith('https://timeout.example')) throw new Error('ETIMEDOUT');
      return new Response(JSON.stringify(edgeDoc), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const hits = await up.search('@mqttsnet/thinglinks-edge-nodes');
  assert.deepEqual(hits.map((hit) => [hit.name, hit.source]), [[edgeDoc.name, 'npm']]);
});

test('an exact non-node package stays empty without fuzzy fallback', async () => {
  let fuzzyCalls = 0;
  const up = new UpstreamRegistry({
    sources: () => [{ name: 'npm', url: 'https://up.example' }],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).includes('/-/v1/search')) {
        fuzzyCalls++;
        return new Response(JSON.stringify({ objects: [{ package: {
          name: edgeDoc.name, version: '0.0.1', keywords: ['node-red'],
        } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        name: 'ordinary-thinglinks-lib',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'ordinary-thinglinks-lib', version: '1.0.0' } },
      }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await up.search('ordinary-thinglinks-lib'), []);
  assert.equal(fuzzyCalls, 0);
});

test('the first exact source is authoritative even when a later source has a node package', async () => {
  const up = new UpstreamRegistry({
    sources: () => [
      { name: 'common', url: 'https://common.example' },
      { name: 'npm', url: 'https://up.example' },
    ],
    fetchImpl: (async (url: string | URL) => String(url).startsWith('https://common.example')
      ? new Response(JSON.stringify({
        name: edgeDoc.name,
        'dist-tags': { latest: '0.0.1' },
        versions: { '0.0.1': { name: edgeDoc.name, version: '0.0.1' } },
      }), { status: 200 })
      : new Response(JSON.stringify(edgeDoc), { status: 200 })) as unknown as typeof fetch,
  });
  assert.deepEqual(await up.search(edgeDoc.name), []);
});

test('a source failure plus remaining exact 404s is reported instead of becoming fuzzy search', async () => {
  let fuzzyCalls = 0;
  const up = new UpstreamRegistry({
    sources: () => [
      { name: 'timeout', url: 'https://timeout.example' },
      { name: 'npm', url: 'https://up.example' },
    ],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).includes('/-/v1/search')) fuzzyCalls++;
      if (String(url).startsWith('https://timeout.example')) throw new Error('ETIMEDOUT');
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => up.search('thinglinks'), /所有节点源都取不到 thinglinks.*ETIMEDOUT/);
  assert.equal(fuzzyCalls, 0);
});

test('duplicate exact node packages honor configured source priority', async () => {
  const firstDoc = structuredClone(edgeDoc);
  firstDoc['dist-tags'] = { latest: '0.0.1' };
  const secondDoc = structuredClone(edgeDoc);
  secondDoc['dist-tags'] = { latest: '0.0.2' };
  secondDoc.versions['0.0.2'] = {
    ...edgeDoc.versions['0.0.1'], version: '0.0.2',
  };
  const up = new UpstreamRegistry({
    sources: () => [
      { name: 'first', url: 'https://first.example' },
      { name: 'second', url: 'https://second.example' },
    ],
    fetchImpl: (async (url: string | URL) => new Response(JSON.stringify(
      String(url).startsWith('https://first.example') ? firstDoc : secondDoc,
    ), { status: 200 })) as unknown as typeof fetch,
  });
  assert.deepEqual((await up.search(edgeDoc.name)).map((hit) => [hit.version, hit.source]), [['0.0.1', 'first']]);
});

test('fuzzy search sends plain text and filters non-node packages locally', async () => {
  let requested = '';
  const up = new UpstreamRegistry({
    sources: () => [{ name: 'npm', url: 'https://up.example' }],
    fetchImpl: (async (url: string | URL) => {
      requested = decodeURIComponent(String(url));
      return new Response(JSON.stringify({ objects: [
        { package: {
          name: '@mqttsnet/thinglinks-edge-nodes',
          version: '0.0.1',
          description: 'ThingLinks Edge nodes',
          keywords: ['thinglinks', 'node-red'],
        } },
        { package: {
          name: 'ordinary-thinglinks-lib',
          version: '1.0.0',
          description: 'ordinary library',
          keywords: ['thinglinks'],
        } },
      ] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const hits = await up.search('thinglinks edge');
  assert.match(requested, /text=thinglinks edge/);
  assert.doesNotMatch(requested, /keywords:node-red/);
  assert.deepEqual(hits.map((hit) => hit.name), ['@mqttsnet/thinglinks-edge-nodes']);
});

test('fuzzy search keeps mixed-case node-red keywords', async () => {
  const impl = (async () => new Response(JSON.stringify({ objects: [{ package: {
    name: 'node-red-contrib-thinglinks', version: '1.0.0',
    description: 'ThingLinks extra node', keywords: ['thinglinks', 'Node-RED'],
  } }] }), { status: 200 })) as unknown as typeof fetch;
  const mixed = new UpstreamRegistry({
    sources: () => [{ name: 'npm', url: 'https://up.example' }], fetchImpl: impl,
  });
  assert.deepEqual((await mixed.search('thinglinks extra')).map((hit) => hit.name), ['node-red-contrib-thinglinks']);
});

test('fuzzy search continues after a failed source and preserves successful source attribution', async () => {
  const up = new UpstreamRegistry({
    sources: () => [
      { name: 'failed', url: 'https://failed.example' },
      { name: 'second', url: 'https://second.example' },
    ],
    fetchImpl: (async (url: string | URL) => {
      if (String(url).startsWith('https://failed.example')) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ objects: [{ package: {
        name: 'node-red-contrib-thinglinks', version: '1.0.0',
        description: 'ThingLinks extra node', keywords: ['thinglinks', 'node-red'],
      } }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual((await up.search('thinglinks extra')).map((hit) => [hit.name, hit.source]), [
    ['node-red-contrib-thinglinks', 'second'],
  ]);
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
  const hits = await up.search('node');
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
  assert.deepEqual((await up.search('a node')).map((h) => h.name), ['a-node']);
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
