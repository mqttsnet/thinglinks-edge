/**
 * 物模型同步（11 号文契约，已逐字段核对云侧实现）。
 *
 * 边缘要知道「一个服务下有哪些属性、什么量纲、什么类型」，才能校验上行数据、
 * 给点位配置提供候选。物模型的权威在云端，边缘按需拉取并缓存快照。
 *
 * 契约要点：
 *   · 上行 `model/query` → 下行 `model/queryResponse`，走同一套信封
 *   · 两个标识都缺省 = 「给我我自己的物模型」，边缘最常用的形态
 *   · **分片按服务切，不按字节切** —— 每片都是结构完整的 JSON，收一片合一片，
 *     设备侧不需要拼接缓冲区
 */

/** 云侧 ProductModelQueryStatusEnum */
export const MODEL_STATUS = {
  SUCCESS: 0,
  FORBIDDEN: 1,
  SNAPSHOT_NOT_FOUND: 2,
  INVALID_PARAM: 3,
  VERSION_NOT_PUBLISHED: 4,
} as const;

export interface ModelQueryRequest {
  /** 缺省 = 发起设备自己的产品 */
  productIdentification?: string;
  /** 缺省 = 发起设备自己的 boundProductVersionNo */
  versionNo?: string;
  /** 只要这几个服务；空 = 全部 */
  serviceCodes?: string[];
  /** 分片续拉游标 */
  serviceOffset?: number;
}

export interface ModelProperty {
  propertyCode: string;
  propertyName?: string;
  datatype?: string;
  unit?: string;
  max?: string;
  min?: string;
  step?: string;
  maxlength?: string;
  enumlist?: string;
  required?: string;
  method?: string;
  description?: string;
}

export interface ModelService {
  serviceCode: string;
  serviceName?: string;
  serviceType?: string;
  serviceStatus?: number;
  description?: string;
  properties?: ModelProperty[];
  commands?: unknown[];
}

export interface ProductModel {
  productIdentification?: string;
  productName?: string;
  productType?: number;
  manufacturerId?: string;
  manufacturerName?: string;
  model?: string;
  dataFormat?: string;
  deviceType?: string;
  protocolType?: string;
  remark?: string;
  services?: ModelService[];
}

export interface ModelQueryResponse {
  statusCode: number;
  statusDesc: string;
  productIdentification?: string;
  versionNo?: string;
  serviceTotal?: number;
  serviceOffset?: number;
  hasMore?: boolean;
  /** 失败时**不返回**该字段 */
  model?: ProductModel;
}

export class ModelQueryError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, statusDesc: string) {
    super(`物模型查询失败（${statusCode}）：${statusDesc}`);
    this.name = 'ModelQueryError';
    this.statusCode = statusCode;
  }
}

/** 单轮请求-响应的执行器，由网关提供 */
export type ModelTransport = (req: ModelQueryRequest) => Promise<ModelQueryResponse>;

/** 分片上限：正常产品一次拉完，这个数只是防止云端行为异常时无限循环 */
const MAX_PAGES = 64;

/**
 * 拉取完整物模型，自动续拉分片。
 *
 * 分片按服务切，所以合并就是把各片的 `services` 顺序拼起来 ——
 * 不需要拼接字节缓冲区，也不会出现「拼到一半 JSON 解不开」。
 */
export async function fetchModel(
  transport: ModelTransport,
  req: ModelQueryRequest = {},
): Promise<{ model: ProductModel; versionNo?: string; pages: number; serviceTotal?: number }> {
  const services: ModelService[] = [];
  let offset = req.serviceOffset ?? 0;
  let merged: ProductModel | undefined;
  let versionNo: string | undefined;
  let serviceTotal: number | undefined;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new ModelQueryError(-1, `分片超过 ${MAX_PAGES} 轮仍未结束，疑似云端 hasMore 不收敛`);
    }
    const res = await transport({ ...req, serviceOffset: offset });
    pages += 1;

    if (res.statusCode !== MODEL_STATUS.SUCCESS) {
      // 失败时云侧不返回 model，直接抛错而不是返回半个模型
      throw new ModelQueryError(res.statusCode, res.statusDesc);
    }

    const page = res.model;
    if (!merged) {
      // 只留产品级字段，services 由各片累加而来
      const { services: _ignored, ...productLevel } = page ?? {};
      merged = productLevel;
    }
    versionNo = res.versionNo ?? versionNo;
    serviceTotal = res.serviceTotal ?? serviceTotal;
    services.push(...(page?.services ?? []));

    if (res.hasMore !== true) break;

    const advanced = (res.serviceOffset ?? offset) + (page?.services?.length ?? 0);
    if (advanced <= offset) {
      // 游标没前进却说还有更多 —— 再拉一次只会拿到同一片，必须中止
      throw new ModelQueryError(-1, `分片游标未前进（${offset} → ${advanced}），中止以免死循环`);
    }
    offset = advanced;
  }

  const model: ProductModel = { ...(merged ?? {}), services };
  return {
    model,
    ...(versionNo === undefined ? {} : { versionNo }),
    pages,
    ...(serviceTotal === undefined ? {} : { serviceTotal }),
  };
}

/** 把物模型摊平成「服务码 → 属性码 → 属性定义」，供点位校验与配置候选使用 */
export function indexProperties(model: ProductModel): Map<string, Map<string, ModelProperty>> {
  const out = new Map<string, Map<string, ModelProperty>>();
  for (const svc of model.services ?? []) {
    const props = new Map<string, ModelProperty>();
    for (const p of svc.properties ?? []) props.set(p.propertyCode, p);
    out.set(svc.serviceCode, props);
  }
  return out;
}
