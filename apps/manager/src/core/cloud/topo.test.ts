import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAddPayload, buildUpdatePayload, buildDeletePayload, chunk, summarizeAddResult,
  DEFAULT_BATCH_SIZE, TOPO_SUCCESS, TOPO_FAILURE, TopoError, type SubDeviceInfo,
} from './topo.ts';

const dev = (n: number): SubDeviceInfo => ({ nodeId: `plc-${n}`, name: `#${n} 注塑机` });

test('注册报文字段与云侧 TopoAddSubDeviceParam 一致', () => {
  const p = buildAddPayload('edge-01', [
    { nodeId: 'plc-1', name: '1#注塑机', description: '车间东侧', manufacturerId: 'siemens', model: 'S7-1200' },
  ]);
  assert.deepEqual(p, {
    gatewayIdentification: 'edge-01',
    deviceInfos: [{ nodeId: 'plc-1', name: '1#注塑机', description: '车间东侧',
                    manufacturerId: 'siemens', model: 'S7-1200' }],
  });
});

test('可选字段缺省时不出现在报文里，不发 undefined', () => {
  const p = buildAddPayload('edge-01', [{ nodeId: 'plc-1', name: 'x' }]);
  assert.deepEqual(Object.keys(p.deviceInfos[0]!), ['nodeId', 'name']);
  assert.ok(!JSON.stringify(p).includes('null'));
});

test('nodeId 为空或重复立刻报错', () => {
  assert.throws(() => buildAddPayload('g', [{ nodeId: '', name: 'x' }]), TopoError);
  assert.throws(() => buildAddPayload('g', [{ nodeId: '  ', name: 'x' }]), TopoError);
  assert.throws(() => buildAddPayload('g', [dev(1), dev(1)]), /nodeId 重复/);
  assert.throws(() => buildAddPayload('g', []), /列表为空/);
});

test('状态用枚举名而不是数字', () => {
  const p = buildUpdatePayload('edge-01', [{ deviceId: 'd1', status: 'ONLINE' }]);
  assert.equal(p.deviceStatuses[0]!.status, 'ONLINE');
  assert.ok(!JSON.stringify(p).includes('"status":1'), '不能退化成数字，那依赖 ordinal 巧合');
});

test('删除报文只带 deviceIds', () => {
  assert.deepEqual(buildDeletePayload('edge-01', ['a', 'b']),
                   { gatewayIdentification: 'edge-01', deviceIds: ['a', 'b'] });
  assert.throws(() => buildDeletePayload('edge-01', []), TopoError);
  assert.throws(() => buildDeletePayload('edge-01', ['a', '']), TopoError);
});

test('分批：边界与默认大小', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 100);
  const items = Array.from({ length: 250 }, (_, i) => i);
  const batches = chunk(items);
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
  assert.deepEqual(batches.flat(), items, '分批不能丢也不能重');
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
  assert.throws(() => chunk([1], 0), TopoError);
});

test('顶层成功但逐条有失败时，不能报告成功', () => {
  // 这是最容易写错的一处：只看顶层 statusCode 会把部分失败当成全成功
  const s = summarizeAddResult({
    statusCode: TOPO_SUCCESS, statusDesc: 'success',
    data: [
      { statusCode: TOPO_SUCCESS, statusDesc: 'success' },
      { statusCode: TOPO_FAILURE, statusDesc: '设备已存在' },
      { statusCode: TOPO_SUCCESS, statusDesc: 'success' },
    ],
  });
  assert.equal(s.ok, false);
  assert.equal(s.succeeded, 2);
  assert.deepEqual(s.failed, [{ index: 1, statusDesc: '设备已存在' }]);
});

test('全部成功时 ok 为真', () => {
  const s = summarizeAddResult({
    statusCode: TOPO_SUCCESS, statusDesc: 'success',
    data: [{ statusCode: TOPO_SUCCESS, statusDesc: 'success' }],
  });
  assert.deepEqual(s, { ok: true, succeeded: 1, failed: [] });
});

test('状态码 0 是成功 —— 不是 HTTP 风格的 200', () => {
  assert.equal(TOPO_SUCCESS, 0);
  assert.equal(TOPO_FAILURE, 1);
  assert.equal(summarizeAddResult({ statusCode: 1, statusDesc: 'failure', data: [] }).ok, false);
});
