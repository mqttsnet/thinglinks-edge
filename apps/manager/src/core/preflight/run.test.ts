import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, renderReport } from './run.ts';
import { summarize, pass, fail, skip } from './types.ts';

const input = (over: Record<string, unknown> = {}) => ({
  externalUrl: 'http://127.0.0.1:19100',
  listenAddr: '127.0.0.1', listenPort: 0,   // 0 = 让系统挑，必然可用
  dataDir: '/tmp', portRange: { min: 39000, max: 39099 },
  images: ['nodered/node-red:5.0.4-24-minimal'],
  corporateCidrs: [] as string[], ntpServer: '',
  docker: undefined,
  hostStats: async () => ({ diskTotalGb: 100, diskUsedGb: 40, diskPercent: 40 }),
  timeoutMs: 800,
  ...over,
} as Parameters<typeof runPreflight>[0]);

test('没有 Docker 端点时，四项 docker 检查如实跳过而不是通过', async () => {
  const r = await runPreflight(input());
  const dockerChecks = r.checks.filter((c) => c.id.startsWith('docker.'));
  assert.equal(dockerChecks.length, 4);
  assert.ok(dockerChecks.every((c) => c.status === 'skip'), '跳过，不能报成 pass');
});

test('九项检查一项不少', async () => {
  const r = await runPreflight(input());
  const ids = new Set(r.checks.map((c) => c.id));
  for (const want of [
    'docker.available', 'docker.arch', 'docker.cgroup-memory', 'docker.network-conflict',
    'host.port.manager', 'host.port.range', 'host.disk', 'host.clock',
    'endpoint.reachable', 'endpoint.certificate',
  ]) {
    assert.ok(ids.has(want), `缺检查项 ${want}`);
  }
});

/*
 * 自检最没用的形态是「第一项挂了、剩下八项没跑」——
 * 现场只能修一项跑一次，来回好几轮。
 */
test('单项检查自己抛错，不影响其余项', async () => {
  const r = await runPreflight(input({
    hostStats: async () => { throw new Error('读不到 /proc'); },
  }));
  const disk = r.checks.find((c) => c.id === 'host.disk');
  assert.equal(disk?.status, 'skip');
  assert.match(disk!.detail, /读不到/);
  assert.ok(r.checks.length >= 9, '其余项照常跑完');
});

test('磁盘不足要阻断，整份报告 ok 变 false', async () => {
  const r = await runPreflight(input({
    hostStats: async () => ({ diskTotalGb: 100, diskUsedGb: 98, diskPercent: 98 }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.blocking >= 1, true);
  assert.equal(r.checks.find((c) => c.id === 'host.disk')?.severity, 'block');
});

test('磁盘偏紧只告警，不阻断安装', async () => {
  const r = await runPreflight(input({
    hostStats: async () => ({ diskTotalGb: 100, diskUsedGb: 90, diskPercent: 90 }),
  }));
  assert.equal(r.checks.find((c) => c.id === 'host.disk')?.severity, 'warn');
  assert.equal(r.ok, true, '告警不该拦住安装');
});

test('未配 NTP 时时钟项跳过，并提示后果', async () => {
  const r = await runPreflight(input());
  const clock = r.checks.find((c) => c.id === 'host.clock');
  assert.equal(clock?.status, 'skip');
  assert.match(clock!.detail, /验签/, '要说清时钟偏差会伪装成签名错误');
});

test('http 部署时证书项跳过，不报成失败', async () => {
  const r = await runPreflight(input());
  assert.equal(r.checks.find((c) => c.id === 'endpoint.certificate')?.status, 'skip');
});

// ── 报告渲染 ────────────────────────────────────

test('阻断项排在最前 —— 现场先要看的是能不能装', () => {
  const rep = summarize([
    pass('a', '甲', '好'),
    fail('b', '乙', 'warn', '有点问题'),
    fail('c', '丙', 'block', '不能装'),
    skip('d', '丁', '没查'),
  ]);
  const lines = renderReport(rep).split('\n');
  const idx = (n: string) => lines.findIndex((l) => l.includes(n));
  assert.ok(idx('丙') < idx('乙'), '阻断要排在告警前');
  assert.ok(idx('乙') < idx('丁'), '告警要排在跳过前');
  assert.ok(idx('丁') < idx('甲'), '跳过要排在通过前');
});

test('有阻断时结论写「不建议安装」，没有时写「可以安装」', () => {
  assert.match(renderReport(summarize([fail('a', '甲', 'block', 'x')])), /不建议安装/);
  assert.match(renderReport(summarize([pass('a', '甲', 'x')])), /可以安装/);
});

/*
 * 「跳过」被读成「通过」是自检变成安慰剂最常见的方式，
 * 所以报告里必须显式说明这一点。
 */
test('有跳过项时，报告显式说明「未检查不等于通过」', () => {
  const t = renderReport(summarize([skip('a', '甲', '没配 NTP')]));
  assert.match(t, /未检查/);
  assert.match(t, /不等于通过/);
});

test('全通过时不出现那段说明，避免噪音', () => {
  assert.ok(!renderReport(summarize([pass('a', '甲', 'x')])).includes('不等于通过'));
});
