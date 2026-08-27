import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchModel, indexProperties, ModelQueryError, MODEL_STATUS,
  type ModelQueryRequest, type ModelQueryResponse,
} from './model-client.ts';

const svc = (code: string, props: string[] = []) => ({
  serviceCode: code, serviceName: code,
  properties: props.map((p) => ({ propertyCode: p, propertyName: p, datatype: 'float', unit: '°C' })),
});

/** 造一个按服务分片的假云端 */
function pagedCloud(allServices: ReturnType<typeof svc>[], pageSize: number) {
  const calls: ModelQueryRequest[] = [];
  return {
    calls,
    transport: async (req: ModelQueryRequest): Promise<ModelQueryResponse> => {
      calls.push(req);
      const off = req.serviceOffset ?? 0;
      const slice = allServices.slice(off, off + pageSize);
      return {
        statusCode: MODEL_STATUS.SUCCESS, statusDesc: 'success',
        productIdentification: 'TL_EDGE_GATEWAY', versionNo: '1699001299999999',
        serviceTotal: allServices.length, serviceOffset: off,
        hasMore: off + slice.length < allServices.length,
        model: { productIdentification: 'TL_EDGE_GATEWAY', productName: '边缘网关', services: slice },
      };
    },
  };
}

test('状态码取值与云侧 ProductModelQueryStatusEnum 一致', () => {
  assert.deepEqual(MODEL_STATUS,
    { SUCCESS: 0, FORBIDDEN: 1, SNAPSHOT_NOT_FOUND: 2, INVALID_PARAM: 3, VERSION_NOT_PUBLISHED: 4 });
});

test('一次拉完时不产生第二轮请求', async () => {
  const c = pagedCloud([svc('env'), svc('power')], 10);
  const r = await fetchModel(c.transport);
  assert.equal(r.pages, 1);
  assert.equal(r.model.services!.length, 2);
  assert.equal(r.versionNo, '1699001299999999');
});

test('分片按服务切：多轮续拉后服务完整且不重不漏', async () => {
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => svc(n));
  const c = pagedCloud(all, 3);
  const r = await fetchModel(c.transport);
  assert.equal(r.pages, 3, `7 个服务按 3 个一片应拉 3 轮，实际 ${r.pages}`);
  assert.deepEqual(r.model.services!.map((s) => s.serviceCode), ['a','b','c','d','e','f','g']);
  assert.deepEqual(c.calls.map((x) => x.serviceOffset), [0, 3, 6], '游标应按已收服务数前进');
  assert.equal(r.serviceTotal, 7);
});

test('产品级字段来自第一片，不被后续片覆盖成空', async () => {
  const c = pagedCloud([svc('a'), svc('b'), svc('c')], 1);
  const r = await fetchModel(c.transport);
  assert.equal(r.model.productIdentification, 'TL_EDGE_GATEWAY');
  assert.equal(r.model.productName, '边缘网关');
  assert.equal(r.model.services!.length, 3);
});

test('两个标识都缺省 —— 边缘最常用的「给我我自己的物模型」', async () => {
  const c = pagedCloud([svc('env')], 10);
  await fetchModel(c.transport);
  assert.equal(c.calls[0]!.productIdentification, undefined);
  assert.equal(c.calls[0]!.versionNo, undefined);
});

test('可只要指定的几个服务', async () => {
  const c = pagedCloud([svc('env')], 10);
  await fetchModel(c.transport, { serviceCodes: ['env'] });
  assert.deepEqual(c.calls[0]!.serviceCodes, ['env']);
});

test('失败状态直接抛错，不返回半个模型', async () => {
  for (const [code, desc] of [[1, 'forbidden'], [2, 'snapshot not found'],
                              [3, 'invalid param'], [4, 'version not published']] as const) {
    const t = async (): Promise<ModelQueryResponse> => ({ statusCode: code, statusDesc: desc });
    await assert.rejects(() => fetchModel(t), (e: unknown) => {
      assert.ok(e instanceof ModelQueryError);
      assert.equal(e.statusCode, code);
      return true;
    }, `状态 ${code} 应抛错`);
  }
});

test('草稿版本被挡下时错误里带得出原因', async () => {
  const t = async (): Promise<ModelQueryResponse> =>
    ({ statusCode: 4, statusDesc: 'version not published' });
  await assert.rejects(() => fetchModel(t), /version not published/);
});

test('游标不前进却说还有更多时中止，不无限拉', async () => {
  // 云端行为异常时必须自保，否则边缘会卡在死循环里刷消息
  const t = async (): Promise<ModelQueryResponse> => ({
    statusCode: 0, statusDesc: 'success', serviceOffset: 0, hasMore: true,
    model: { services: [] },
  });
  await assert.rejects(() => fetchModel(t), /游标未前进/);
});

test('hasMore 永远为真时有轮次上限兜底', async () => {
  let n = 0;
  const t = async (): Promise<ModelQueryResponse> => ({
    statusCode: 0, statusDesc: 'success', serviceOffset: n, hasMore: true,
    model: { services: [svc(`s${n++}`)] },
  });
  await assert.rejects(() => fetchModel(t), /hasMore 不收敛/);
});

test('摊平成 服务→属性 索引，供点位校验用', () => {
  const idx = indexProperties({ services: [svc('env', ['temp', 'humi']), svc('power', ['kw'])] });
  assert.deepEqual([...idx.keys()], ['env', 'power']);
  assert.equal(idx.get('env')!.get('temp')!.unit, '°C');
  assert.equal(idx.get('env')!.get('nope'), undefined);
  assert.equal(idx.get('power')!.size, 1);
});

test('空模型不炸', () => {
  assert.equal(indexProperties({}).size, 0);
  assert.equal(indexProperties({ services: [] }).size, 0);
});
