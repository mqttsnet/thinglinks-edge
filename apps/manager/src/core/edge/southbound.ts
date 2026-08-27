/**
 * 南向探测 —— 06 号文的**方案 A**，尽力而为，不是可靠台账。
 *
 * 用户用原生 modbus / OPC UA / S7 节点接的设备，平台本来完全看不见。
 * 这里解析实例的 `flows.json` 把它们**尽量**认出来，让界面不至于一片空白。
 *
 * 文档把边界写得很清楚，这里再写一遍，因为它决定了整个模块该怎么用：
 *
 *   · **脆弱**：节点类型繁多、各家配置格式不同、版本升级会改结构
 *   · **拿不到运行时**：没有当前值、没有质量码 —— 那些只有方案 B 的节点集才有
 *   · **可能漏**：用 function 节点动态构造地址的，这里认不出来
 *
 * 所以结果一律带 `managed: false`，界面必须标「未纳管」。
 * 让用户以为看到的是全部，是诚信问题（06 号文原话）。
 *
 * 字段名不是猜的：从 node-red-contrib-modbus@5.60.2 / -opcua@0.2.355 / -s7@3.1.3
 * 的 `.html` 里 `defaults` 块实读而来。
 */

export interface ProbedDevice {
  /** 取 Node-RED 配置节点的 id —— 它在流里就是设备的身份 */
  nodeId: string;
  name: string;
  protocol: string;
  address: string;
  /** 原始节点类型，便于用户对回流里的哪个节点 */
  sourceType: string;
}

export interface ProbedTag {
  /** 所属设备（配置节点 id）；找不到归属时为空 */
  nodeId: string;
  tagId: string;
  name: string;
  /** 寄存器地址 / 变量名 / OPC UA NodeId */
  address: string;
  dataType: string;
  sourceType: string;
}

export interface ProbeResult {
  devices: ProbedDevice[];
  tags: ProbedTag[];
  /** 见到但认不出的节点类型 —— 必须如实告知「还有这些我看不懂」 */
  unrecognized: { type: string; count: number }[];
  /** 恒为 false。方案 A 永远不是可靠台账 */
  managed: false;
}

type Node = Record<string, unknown>;
const str = (n: Node, k: string): string => {
  const v = n[k];
  return v === undefined || v === null ? '' : String(v);
};

/** Node-RED 自带节点与我们自己的节点，不计入「认不出」 */
const BENIGN = new Set([
  'tab', 'subflow', 'group', 'comment', 'junction', 'global-config', 'unknown',
  'inject', 'debug', 'function', 'switch', 'change', 'range', 'template', 'delay',
  'trigger', 'exec', 'rbe', 'complete', 'catch', 'status', 'link in', 'link out',
  'link call', 'split', 'join', 'sort', 'batch', 'csv', 'html', 'json', 'xml', 'yaml',
  'file', 'file in', 'watch', 'http in', 'http response', 'http request', 'http proxy',
  'mqtt in', 'mqtt out', 'mqtt-broker', 'websocket in', 'websocket out',
  'websocket-listener', 'websocket-client', 'tcp in', 'tcp out', 'tcp request',
  'udp in', 'udp out', 'tls-config',
  'tl-device', 'tl-tag', 'tl-uplink',
]);

/**
 * 认得出、但**不承载设备或点位**的南向节点。
 *
 * 和「认不出」要分开：这些我们知道是什么（从站服务端、响应过滤、浏览器、方法调用……），
 * 只是它们背后没有设备台账。混进 `unrecognized` 会让用户以为平台漏认了东西。
 */
const KNOWN_NON_DEVICE = new Set([
  'modbus-server', 'modbus-response', 'modbus-response-filter', 'modbus-io-config',
  'modbus-queue-info', 'modbus-flex-connector', 'modbus-flex-sequencer', 'modbus-flex-fc',
  'OpcUa-Browser', 'OpcUa-Discovery', 'OpcUa-Event', 'OpcUa-Method', 'OpcUa-Rights',
  'OpcUa-Server', 'OpcUa-Client',
  's7 control',
]);

/** 认得出的设备型（配置）节点：类型 → 提取器 */
const DEVICE_EXTRACTORS: Record<string, (n: Node) => Omit<ProbedDevice, 'nodeId' | 'sourceType'>> = {
  'modbus-client': (n) => {
    const serial = str(n, 'clienttype').toLowerCase().includes('serial');
    return {
      name: str(n, 'name') || (serial ? str(n, 'serialPort') : str(n, 'tcpHost')),
      protocol: serial ? 'modbus-rtu' : 'modbus-tcp',
      address: serial
        ? `${str(n, 'serialPort')}@${str(n, 'serialBaudrate')}`
        : `${str(n, 'tcpHost')}:${str(n, 'tcpPort')}`,
    };
  },
  's7 endpoint': (n) => ({
    name: str(n, 'name') || str(n, 'address'),
    protocol: 's7',
    address: `${str(n, 'address')}:${str(n, 'port')} rack=${str(n, 'rack')} slot=${str(n, 'slot')}`,
  }),
  'OpcUa-Endpoint': (n) => ({
    name: str(n, 'name') || str(n, 'endpoint'),
    protocol: 'opcua',
    address: str(n, 'endpoint'),
  }),
};

/** 认得出的点位型节点：类型 → [归属字段, 提取器] */
const TAG_EXTRACTORS: Record<string, [string, (n: Node) => Omit<ProbedTag, 'nodeId' | 'tagId' | 'sourceType'>]> = {
  'modbus-read':         ['server', modbusTag],
  'modbus-write':        ['server', modbusTag],
  'modbus-getter':       ['server', modbusTag],
  'modbus-flex-getter':  ['server', modbusTag],
  'modbus-flex-write':   ['server', modbusTag],
  's7 in':               ['endpoint', (n) => ({
    name: str(n, 'name') || str(n, 'variable'),
    address: str(n, 'variable'),
    dataType: str(n, 'mode'),
  })],
  's7 out':              ['endpoint', (n) => ({
    name: str(n, 'name') || str(n, 'variable'),
    address: str(n, 'variable'),
    dataType: str(n, 'mode'),
  })],
  'OpcUa-Item':          ['', (n) => ({
    name: str(n, 'name') || str(n, 'item'),
    address: str(n, 'item'),
    dataType: str(n, 'datatype'),
  })],
};

function modbusTag(n: Node): Omit<ProbedTag, 'nodeId' | 'tagId' | 'sourceType'> {
  const adr = str(n, 'adr');
  const qty = str(n, 'quantity');
  return {
    name: str(n, 'name') || str(n, 'topic') || (adr === '' ? '' : `addr ${adr}`),
    // 地址给全：功能码 + 起始地址 + 数量，缺一都对不回现场的寄存器表
    address: [str(n, 'dataType'), adr && `adr=${adr}`, qty && `qty=${qty}`,
              str(n, 'unitid') && `unit=${str(n, 'unitid')}`].filter(Boolean).join(' '),
    dataType: str(n, 'dataType'),
  };
}

/**
 * 探测一份 flows.json。
 *
 * 输入是 Node-RED 存下来的原始数组；格式不对时返回空结果而不是抛错 ——
 * 用户的流坏了不该让整个界面挂掉。
 */
export function probeFlows(flows: unknown): ProbeResult {
  const empty: ProbeResult = { devices: [], tags: [], unrecognized: [], managed: false };
  if (!Array.isArray(flows)) return empty;

  const devices: ProbedDevice[] = [];
  const tags: ProbedTag[] = [];
  const seenUnknown = new Map<string, number>();

  for (const raw of flows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const n = raw as Node;
    const type = str(n, 'type');
    const id = str(n, 'id');
    if (type === '' || id === '') continue;

    const devExtract = DEVICE_EXTRACTORS[type];
    if (devExtract) {
      devices.push({ nodeId: id, sourceType: type, ...devExtract(n) });
      continue;
    }

    const tagEntry = TAG_EXTRACTORS[type];
    if (tagEntry) {
      const [ownerField, extract] = tagEntry;
      tags.push({
        nodeId: ownerField === '' ? '' : str(n, ownerField),
        tagId: id,
        sourceType: type,
        ...extract(n),
      });
      continue;
    }

    if (!BENIGN.has(type) && !KNOWN_NON_DEVICE.has(type)) {
      seenUnknown.set(type, (seenUnknown.get(type) ?? 0) + 1);
    }
  }

  return {
    devices,
    tags,
    unrecognized: [...seenUnknown.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    managed: false,
  };
}
