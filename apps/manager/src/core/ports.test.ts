import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  parsePortSpec, checkAgainstRecords, recommendPorts,
  validatePortSpec, probeHostPort, PortError,
} from './ports.ts';

const RANGE = { min: 30000, max: 30999 };
const noneUsed = new Map<number, string>();

test('解析区间、单个与组合', () => {
  assert.deepEqual(parsePortSpec('30101-30103').ports, [30101, 30102, 30103]);
  assert.deepEqual(parsePortSpec('30101').ports, [30101]);
  assert.deepEqual(parsePortSpec('30101-30102,30150').ports, [30101, 30102, 30150]);
  assert.deepEqual(parsePortSpec('30101, 30150').ports, [30101, 30150]);
  assert.deepEqual(parsePortSpec('30101，30150').ports, [30101, 30150], '全角逗号也应支持');
});

test('去重且保持顺序', () => {
  assert.deepEqual(parsePortSpec('30101,30101,30102').ports, [30101, 30102]);
});

test('空输入表示不映射端口', () => {
  assert.deepEqual(parsePortSpec('').ports, []);
  assert.deepEqual(parsePortSpec('   ').ports, []);
});

test('区间过大与倒序被拒，且回报原始片段', () => {
  assert.match(parsePortSpec('30000-30900').invalid[0] ?? '', /超过 200/);
  assert.match(parsePortSpec('30200-30100').invalid[0] ?? '', /起始端口大于/);
});

test('无法识别的片段被回报而非静默丢弃', () => {
  const r = parsePortSpec('abc,30101');
  assert.deepEqual(r.ports, [30101]);
  assert.match(r.invalid[0] ?? '', /abc/);
});

test('超范围与已占用被检出，并指出占用方', () => {
  const used = new Map([[30001, 'line-a']]);
  const r = checkAgainstRecords([29000, 30001, 30500], RANGE, used);
  assert.deepEqual(r.outOfRange, [29000]);
  assert.deepEqual(r.taken, [{ port: 30001, owner: 'line-a' }]);
});

test('推荐按 step 对齐的连续空闲段', () => {
  assert.equal(recommendPorts(20, RANGE, noneUsed), '30000-30019');
  assert.equal(recommendPorts(1, RANGE, noneUsed), '30000', '单个端口不带区间符');
  assert.equal(recommendPorts(0, RANGE, noneUsed), '');
});

test('推荐会跳过已占用的段', () => {
  const used = new Map([[30005, 'line-a']]);
  assert.equal(recommendPorts(20, RANGE, used), '30020-30039');
});

test('推荐不到空闲段时返回空串而非抛错', () => {
  const tight = { min: 30000, max: 30010 };
  assert.equal(recommendPorts(50, tight, noneUsed), '');
});

test('完整校验：合法输入返回端口列表', async () => {
  assert.deepEqual(await validatePortSpec('30101-30103', RANGE, noneUsed, { probeHost: false }), [30101, 30102, 30103]);
});

test('完整校验：四类问题分别给出可读提示', async () => {
  const used = new Map([[30001, 'line-a']]);
  const cases: Array<[string, RegExp]> = [
    ['abc', /无法解析/],
    ['29000-29005', /超出允许范围/],
    ['30001', /已被占用.*line-a/],
    ['30000-30900', /超过 200/],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => validatePortSpec(input, RANGE, used, { probeHost: false }),
      (e: unknown) => {
        assert.ok(e instanceof PortError);
        assert.match((e as Error).message, pattern, `输入 ${input}`);
        return true;
      },
    );
  }
});

test('宿主实际占用能被探测到 —— 平台记录之外的第二重检测', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const busyPort = (srv.address() as { port: number }).port;

  assert.equal(await probeHostPort(busyPort), true, '已监听的端口应被判为占用');
  srv.close();
});

test('宿主占用会让完整校验失败', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const busyPort = (srv.address() as { port: number }).port;

  await assert.rejects(
    () => validatePortSpec(String(busyPort), { min: 1, max: 65535 }, noneUsed, { probeHost: true }),
    /宿主上已被其它进程占用/,
  );
  srv.close();
});
