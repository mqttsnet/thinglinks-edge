import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from './dns.ts';

test('IP 字面量跳过 DNS，不做无意义的查询', async () => {
  const r = await resolveHost('127.0.0.1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.addresses, ['127.0.0.1']);
  assert.equal(r.elapsedMs, 0, '没查 DNS 就不该有耗时');
});

test('localhost 能通过系统解析器解析出来', async () => {
  const r = await resolveHost('localhost');
  assert.equal(r.ok, true, r.error ?? '');
  assert.ok(r.addresses.length > 0);
});

/*
 * 用**超长标签**（>63 字节）而不是「随便编个不存在的域名」来测失败路径。
 *
 * 后者在这台开发机上会「解析成功」：本机 DNS 走代理的 fake-IP 模式，
 * 任何域名都返回 198.18.x.x（RFC 2544 测试网段）。运营商通配 DNS 也是同样效果。
 * 超长标签在解析器层面就非法，劫持不了，是唯一能稳定复现失败的输入。
 */
test('解析失败时如实报错并带原因，而不是抛异常', async () => {
  const r = await resolveHost('a'.repeat(70) + '.example');
  assert.equal(r.ok, false);
  assert.ok(r.error, '失败必须带原因，否则现场无从下手');
  assert.deepEqual(r.addresses, []);
});

test('解析器返回空记录集时也要给出原因，不能是个没解释的红叉', async () => {
  const r = await resolveHost('');
  assert.equal(r.ok, false);
  assert.ok(r.error, '零记录也必须带原因');
});
