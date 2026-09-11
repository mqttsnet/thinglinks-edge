import { TemplateError, type FlowNode } from '../../types.ts';
import { PLATFORM_NODE_PACKAGE } from '../../../nodes/platform-contract.ts';
import { getProtocol } from '../../../protocols/catalog.ts';
import { transformScript } from '../transform.ts';
import type { TemplateParameter, NodeRequirement } from '../types.ts';

export const identityFields: TemplateParameter[] = [
  {
    key: 'nodeId',
    label: 'ThingLinks 子设备标识',
    type: 'text',
    required: true,
    default: '',
    max: 128,
    description: '填写云端已登记的设备标识，与 Edge 台账使用相同标识。',
    group: 'cloud',
  },
  {
    key: 'serviceCode',
    label: '物模型服务编码',
    type: 'text',
    required: true,
    default: '',
    max: 128,
    group: 'cloud',
  },
  {
    key: 'productIdentification',
    label: '子设备产品标识',
    type: 'text',
    default: '',
    max: 128,
    group: 'cloud',
    description: '读取云端物模型时填写子设备实际所属产品。',
  },
  {
    key: 'versionNo',
    label: '子设备绑定版本',
    type: 'text',
    default: '',
    max: 128,
    group: 'cloud',
    description: '与子设备当前绑定版本一致；读取模型后可选择服务、属性和命令编码。',
  },
];
export const hostField: TemplateParameter = {
  key: 'host',
  label: '设备地址',
  type: 'text',
  default: '',
  max: 253,
};
export const intervalField: TemplateParameter = {
  key: 'interval',
  label: '采集周期（秒）',
  type: 'number',
  default: 5,
  min: 0.1,
  max: 86400,
};
export const scalarTypes = ['number', 'boolean', 'string'];
export const binaryTypes = [
  'uint16be',
  'uint16le',
  'int16be',
  'int16le',
  'uint32be',
  'uint32le',
  'int32be',
  'int32le',
  'float32be',
  'float32le',
  'float32swap',
];
const typeLabels: Record<string, string> = {
  number: '数值',
  boolean: '布尔',
  string: '文本',
  uint16be: '无符号16位 · 高字节在前',
  uint16le: '无符号16位 · 低字节在前',
  int16be: '有符号16位 · 高字节在前',
  int16le: '有符号16位 · 低字节在前',
  uint32be: '无符号32位 · ABCD',
  uint32le: '无符号32位 · DCBA',
  int32be: '有符号32位 · ABCD',
  int32le: '有符号32位 · DCBA',
  float32be: '浮点32位 · ABCD',
  float32le: '浮点32位 · DCBA',
  float32swap: '浮点32位 · CDAB',
};

export function pointTable(
  options: { sourceLabel?: string; sourceDefault?: string; types?: string[] } = {},
): TemplateParameter {
  const types = options.types ?? scalarTypes;
  return {
    key: 'points',
    group: 'points',
    label: '采集点位与物模型映射',
    type: 'table',
    required: true,
    min: 1,
    max: 64,
    default: [
      {
        source: options.sourceDefault ?? 'temperature',
        property: 'temperature',
        dataType: types[0],
        scale: 1,
        offset: 0,
      },
    ],
    columns: [
      {
        key: 'source',
        label: options.sourceLabel ?? '源字段（支持 a.b）',
        type: 'text',
        required: true,
        max: 256,
      },
      { key: 'property', label: '物模型属性编码', type: 'text', required: true, max: 64 },
      {
        key: 'dataType',
        label: '数据类型',
        type: 'select',
        default: types[0],
        options: types.map((value) => ({ value, label: typeLabels[value] ?? value })),
      },
      { key: 'scale', label: '倍率', type: 'number', default: 1, min: -1e12, max: 1e12 },
      { key: 'offset', label: '偏移', type: 'number', default: 0, min: -1e12, max: 1e12 },
    ],
  };
}

export const payloadFormat: TemplateParameter = {
  key: 'format',
  label: '设备报文格式',
  type: 'select',
  default: 'json',
  options: [
    { label: 'JSON 对象', value: 'json' },
    { label: '二进制', value: 'binary' },
  ],
  description: '二进制点位的源字段填写从 0 开始的字节偏移；选择对应的整数或浮点字节序。',
};
export function portField(port: number): TemplateParameter {
  return { key: 'port', label: '端口', type: 'number', default: port, min: 1, max: 65535 };
}
export function requirements(protocol: string): NodeRequirement[] {
  return [
    ...structuredClone(getProtocol(protocol)?.requirements ?? []),
    {
      module: PLATFORM_NODE_PACKAGE.name,
      version: PLATFORM_NODE_PACKAGE.version,
      nodeTypes: ['tl-device', 'tl-uplink'],
    },
  ];
}
export const notes = [
  '云端须已登记子设备，并发布匹配的物模型；模板不会自动创建云端产品或子设备。',
  '此模板提供采集与上报流程，实际设备连通、数据正确性及云端落库需现场验证。',
];

export function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new TemplateError(`${label}必须是整数`);
  return value as number;
}
export function host(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || /[\s/@?#]/.test(text))
    throw new TemplateError('设备地址应为 IP 或主机名，不带协议、路径或凭据');
  return text;
}
export function endpoint(value: unknown, schemes: string[]): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new TemplateError('设备地址不是有效 URL');
  }
  if (!schemes.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new TemplateError('设备 URL 的协议不支持，或包含内联凭据/片段');
  }
  return url.toString();
}
export function pointsOf(p: Record<string, unknown>): Record<string, unknown>[] {
  return p.points as Record<string, unknown>[];
}
export function functionNode(id: string, name: string, func: string, wires: string[][]): FlowNode {
  return {
    id,
    type: 'function',
    z: 'tab',
    name,
    func,
    outputs: wires.length,
    timeout: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 520,
    y: 160,
    wires,
  };
}
export function injectNode(id: string, interval: number, wires: string[][]): FlowNode {
  return {
    id,
    type: 'inject',
    z: 'tab',
    name: '定时采集',
    props: [{ p: 'payload' }],
    payload: '',
    payloadType: 'str',
    repeat: String(interval),
    crontab: '',
    once: true,
    onceDelay: 1,
    x: 140,
    y: 160,
    wires,
  };
}

/** Acquisition inputs wire to `decode`; only successfully decoded data updates device state. */
export function pipeline(
  p: Record<string, unknown>,
  title: string,
  protocol: string,
  address: string,
  inputs: FlowNode[],
  format: string,
  points = pointsOf(p),
): FlowNode[] {
  return [
    { id: 'tab', type: 'tab', label: title, disabled: false, info: notes.join('\n'), env: [] },
    ...inputs,
    functionNode(
      'decode',
      '解析与物模型映射',
      transformScript({ format, points, nodeId: String(p.nodeId), serviceCode: String(p.serviceCode) }),
      [['device']],
    ),
    {
      id: 'device',
      type: 'tl-device',
      z: 'tab',
      name: String(p.nodeId),
      deviceId: String(p.nodeId),
      protocol,
      address,
      model: '',
      manufacturer: '',
      x: 750,
      y: 160,
      wires: [['uplink']],
    },
    {
      id: 'uplink',
      type: 'tl-uplink',
      z: 'tab',
      name: '上报 ThingLinks',
      deviceId: String(p.nodeId),
      serviceId: String(p.serviceCode),
      x: 990,
      y: 160,
      wires: [[]],
    },
    {
      id: 'errors',
      type: 'catch',
      z: 'tab',
      name: '采集异常',
      scope: [...inputs.filter((n) => n.z === 'tab').map((n) => n.id), 'decode', 'device', 'uplink'],
      uncaught: false,
      x: 170,
      y: 330,
      wires: [['error-log']],
    },
    {
      id: 'error-log',
      type: 'debug',
      z: 'tab',
      name: '采集异常信息',
      active: true,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: 'error.message',
      targetType: 'msg',
      x: 430,
      y: 330,
      wires: [],
    },
  ];
}
