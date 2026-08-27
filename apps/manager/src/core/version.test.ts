import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, describe, compareVersions, parseLatest, UpdateChecker } from './version.ts';

test('版本号形如 x.y.z，describe 含产品名', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const s = describe();
  assert.ok(s.includes('ThingLinks Edge Manager'));
  assert.ok(s.includes(VERSION));
});

test('版本比较按数值而非字典序', () => {
  // 字典序会把 0.10.0 判成小于 0.9.0，这是最经典的版本比较错误
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  // 前缀 v 要能容忍：GitHub 的 tag 通常是 v1.2.3
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  // 预发布算旧，避免把 rc 推给现场
  assert.ok(compareVersions('1.2.0-rc1', '1.2.0') < 0);
});

test('parseLatest 兼容 GitHub 与自建两种响应', () => {
  assert.deepEqual(
    parseLatest({ tag_name: 'v0.2.0', html_url: 'https://example.com/r/v0.2.0' }),
    { latest: '0.2.0', url: 'https://example.com/r/v0.2.0' },
  );
  assert.deepEqual(
    parseLatest({ version: '0.3.1', url: 'https://example.com/x' }),
    { latest: '0.3.1', url: 'https://example.com/x' },
  );
  // 拿不到版本号时返回 null，由上层报「响应里没有版本号」而不是当成已最新
  for (const bad of [null, undefined, 'x', {}, { tag_name: '' }, { tag_name: 42 }]) {
    assert.equal(parseLatest(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('未配置检查地址时彻底不联网', async () => {
  // 空串、undefined、纯空白都算「没配置」。
  // 曾经只判 `!== ''`，传 undefined 时被当成已启用并去 fetch(undefined) ——
  // 「没配置」变成「往外连」，把默认不联网这条承诺破掉了
  for (const url of ['', '   ', undefined]) {
    const c = new UpdateChecker({ url });
    assert.equal(c.enabled, false, `${JSON.stringify(url)} 应视为未配置`);
    assert.deepEqual(await c.check(), { enabled: false });
  }
});

test('检查失败如实回报，不伪装成已是最新', async () => {
  // 指向一个必然连不上的地址
  const c = new UpdateChecker({ url: 'http://127.0.0.1:1/nope' });
  const r = await c.check();
  assert.equal(r.enabled, true);
  assert.ok(r.error, '失败必须带 error');
  assert.equal(r.latest, undefined);
  // 关键：outdated 不能是 false —— 那会让界面显示「已是最新」，而其实根本没查到
  assert.equal(r.outdated, undefined);
});

test('结果按间隔缓存，不会每次请求都出网', async () => {
  let hits = 0;
  const srv = (await import('node:http')).createServer((_q, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://e/x' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;

  const c = new UpdateChecker({ url: `http://127.0.0.1:${port}/`, intervalMs: 60_000 });
  const a = await c.check();
  assert.equal(a.latest, '9.9.9');
  assert.equal(a.outdated, true, '9.9.9 应判为比当前版本新');

  await c.check();
  await c.check();
  assert.equal(hits, 1, `缓存期内应只出网一次，实际 ${hits} 次`);

  // 超过间隔后重新查
  await c.check(Date.now() + 120_000);
  assert.equal(hits, 2);

  await new Promise<void>((r) => srv.close(() => r()));
});
