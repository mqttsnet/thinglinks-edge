/**
 * 子设备拓扑：注册 / 状态更新 / 删除。
 *
 * 报文结构逐字段对齐云侧 `TopoAddSubDeviceParam` / `TopoUpdateSubDeviceStatusParam`
 * / `TopoDeleteSubDeviceParam`（thinglinks-link-entity），不是照文档抄的。
 *
 * 两条实读得来、文档里没有的事实：
 *
 *   1. **云侧会用 topic 里的 deviceId 覆盖 `gatewayIdentification`**
 *      （`AddSubDeviceHandler` 里 `setGatewayIdentification(deviceId)`）。
 *      我们照填是为了报文自解释，但它不是可信来源 —— 真正决定挂到哪台网关的是 topic
 *   2. **云侧对 `deviceInfos` 没有条数限制**，它就是个 for 循环。
 *      所以下面的分批是**边缘侧自己的选择**（MQTT 单包大小、broker 限制、
 *      失败时的重试粒度），不是云端契约。别把它写成「云侧要求 100」
 */

/** 云侧 `MqttProtocolTopoStatusEnum`：0 成功 / 1 失败。注意不是 HTTP 风格的 200 */
export const TOPO_SUCCESS = 0;
export const TOPO_FAILURE = 1;

/** 边缘侧自定的单批上限，见上文第 2 条 */
export const DEFAULT_BATCH_SIZE = 100;

export interface SubDeviceInfo {
  /** 子设备在网关下的唯一标识，云侧据此派生设备标识 */
  nodeId: string;
  name: string;
  description?: string;
  manufacturerId?: string;
  model?: string;
}

/**
 * 云侧 `DeviceConnectStatusEnum`。
 *
 * 用**枚举名**而不是数字：该枚举没有 `@JsonValue`，`value` 与 ordinal 恰好都是 0/1/2，
 * 传数字能work只是因为这个巧合 —— 哪天有人往中间插一个枚举值就会静默错位。
 */
export type SubDeviceStatus = 'UNCONNECTED' | 'ONLINE' | 'OFFLINE';

export interface TopoAddPayload {
  gatewayIdentification: string;
  deviceInfos: SubDeviceInfo[];
}

export interface TopoUpdatePayload {
  gatewayIdentification: string;
  deviceStatuses: { deviceId: string; status: SubDeviceStatus }[];
}

export interface TopoDeletePayload {
  gatewayIdentification: string;
  deviceIds: string[];
}

/** `topo/addResponse` 的 dataBody */
export interface TopoAddResult {
  statusCode: number;
  statusDesc: string;
  data?: {
    statusCode: number;
    statusDesc: string;
    deviceInfo?: { name?: string; manufacturerId?: string; description?: string; model?: string };
  }[];
}

/** `topo/update` 与 `topo/delete` 的响应 dataBody */
export interface TopoOperationResult {
  statusCode: number;
  statusDesc: string;
  data?: unknown;
}

export class TopoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopoError';
  }
}

/** nodeId 是云侧派生设备标识的依据，空值会导致整批里那一条静默失败 */
function assertNodeIds(devices: SubDeviceInfo[]): void {
  if (devices.length === 0) throw new TopoError('子设备列表为空');
  const seen = new Set<string>();
  for (const d of devices) {
    if (!d.nodeId || d.nodeId.trim() === '') throw new TopoError('子设备 nodeId 不能为空');
    if (seen.has(d.nodeId)) throw new TopoError(`子设备 nodeId 重复：${d.nodeId}`);
    seen.add(d.nodeId);
  }
}

/** 按边缘侧上限切批。返回的每一批都可以独立发送、独立重试 */
export function chunk<T>(items: T[], size: number = DEFAULT_BATCH_SIZE): T[][] {
  if (size < 1) throw new TopoError(`批大小必须 ≥ 1，收到 ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildAddPayload(gatewayId: string, devices: SubDeviceInfo[]): TopoAddPayload {
  assertNodeIds(devices);
  return {
    gatewayIdentification: gatewayId,
    // 只发云侧认得的字段，多余字段会被 fastjson 忽略但徒增报文体积
    deviceInfos: devices.map((d) => ({
      nodeId: d.nodeId,
      name: d.name,
      ...(d.description === undefined ? {} : { description: d.description }),
      ...(d.manufacturerId === undefined ? {} : { manufacturerId: d.manufacturerId }),
      ...(d.model === undefined ? {} : { model: d.model }),
    })),
  };
}

export function buildUpdatePayload(
  gatewayId: string,
  statuses: { deviceId: string; status: SubDeviceStatus }[],
): TopoUpdatePayload {
  if (statuses.length === 0) throw new TopoError('状态列表为空');
  for (const s of statuses) {
    if (!s.deviceId || s.deviceId.trim() === '') throw new TopoError('deviceId 不能为空');
  }
  return { gatewayIdentification: gatewayId, deviceStatuses: statuses };
}

export function buildDeletePayload(gatewayId: string, deviceIds: string[]): TopoDeletePayload {
  if (deviceIds.length === 0) throw new TopoError('待删除设备列表为空');
  if (deviceIds.some((id) => !id || id.trim() === '')) throw new TopoError('deviceId 不能为空');
  return { gatewayIdentification: gatewayId, deviceIds };
}

/**
 * 判读注册结果。
 *
 * 顶层 `statusCode` 只反映「网关本身是否合法」—— 网关不存在或 nodeType 不是 GATEWAY
 * 时整批失败。**逐条结果在 `data[]` 里**，顶层成功不代表每台子设备都注册成功，
 * 只看顶层会把部分失败当成全成功。
 */
export function summarizeAddResult(result: TopoAddResult): {
  ok: boolean;
  succeeded: number;
  failed: { index: number; statusDesc: string }[];
} {
  const items = result.data ?? [];
  const failed = items
    .map((it, index) => ({ index, statusDesc: it.statusDesc ?? '' , code: it.statusCode }))
    .filter((it) => it.code !== TOPO_SUCCESS)
    .map(({ index, statusDesc }) => ({ index, statusDesc }));
  return {
    ok: result.statusCode === TOPO_SUCCESS && failed.length === 0,
    succeeded: items.length - failed.length,
    failed,
  };
}
