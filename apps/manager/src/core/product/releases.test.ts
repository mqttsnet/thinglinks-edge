import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GithubReleases } from './releases.ts';

test('只按配置仓库查询，合并并发并缓存；发布链接由仓库与tag生成', async () => {
  let calls = 0;
  const service = new GithubReleases('factory/edge', async url => {
    calls++;
    assert.equal(String(url), 'https://api.github.com/repos/factory/edge/releases?per_page=10');
    return new Response(JSON.stringify([{ tag_name: 'v1.2.0', name: '新版', body: '## 更新\n- 完善采集', html_url: 'javascript:alert(1)', draft: false, published_at: '2026-09-10T00:00:00Z' }, { tag_name: 'draft', draft: true }]));
  });
  const [a, b] = await Promise.all([service.read(), service.read()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.releases.length, 1);
  assert.equal(a.releases[0]?.url, 'https://github.com/factory/edge/releases/tag/v1.2.0');
  await service.read();
  assert.equal(calls, 1);
});

test('网络失败与无发布版本分别返回，不伪装成已是最新', async () => {
  const failed = await new GithubReleases('factory/edge', async () => new Response('', { status: 403 })).read();
  assert.equal(failed.state, 'error');
  assert.match(failed.message ?? '', /GitHub/);
  const empty = await new GithubReleases('factory/edge', async () => new Response('[]')).read();
  assert.equal(empty.state, 'ready');
  assert.deepEqual(empty.releases, []);
});

test('拒绝过大响应并限制远程正文长度', async () => {
  const large = await new GithubReleases('factory/edge', async () => new Response('x', { headers: { 'content-length': '2000000' } })).read();
  assert.equal(large.state, 'error');
  const result = await new GithubReleases('factory/edge', async () => new Response(JSON.stringify([{ tag_name: 'v1', body: 'x'.repeat(70_000) }]))).read();
  assert.equal(result.releases[0]?.body.length, 65_536);
  assert.equal(result.releases[0]?.truncated, true);
});
