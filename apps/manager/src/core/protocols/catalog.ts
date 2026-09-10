import type { InstalledModule } from '../flows/admin-client.ts';
import type { NodeRequirement, ProtocolComponentStatus, ProtocolDefinition, ProtocolPackageFacts } from './types.ts';

/** Published registry tarballs inspected and SHA512 verified on 2026-09-09. */
export const PROTOCOL_PACKAGE_PINS = [
  { module: 'node-red-contrib-modbus', version: '5.60.2',
    integrity: 'sha512-CaYWEUMUx0meGt58SJoMSvPQA0iAd9zT+EdFQbo5cjNjnZ+5Z5U/0RR1TMrJ65Edoqk+UavC4sxd34wW19LtCQ==',
    nodeTypes: ['modbus-client', 'modbus-read'] },
  { module: 'node-red-contrib-opcua', version: '0.2.355',
    integrity: 'sha512-QUCiOhl7EYeR9FNDNUd/3OsnWD3Ytib7+FuWA5UQKCViSl/0ZyR5FJlC8KT5pjFIoAnLi4bQ9nGSgXq6vYD+Fw==',
    nodeTypes: ['OpcUa-Endpoint', 'OpcUa-Client', 'OpcUa-Item'] },
  { module: 'node-red-contrib-s7', version: '3.1.3',
    integrity: 'sha512-+aCb96HPFzW750n8TDFEyVZNzbKEBwNqDJMAreD3pdinGrVFg3RyJ4gRisgF4vBX1Shx+JVfuKXtPe3f/oPAgA==',
    nodeTypes: ['s7 endpoint', 's7 in'] },
] as const;

/**
 * Single official npm archive, verified 2026-09-10 against dist.integrity:
 * https://registry.npmjs.org/@tier0%2fopcua-client/0.6.0
 * This is not an offline dependency closure or a bundled ARM64 native artifact.
 */
export const CONTROLLED_OPCUA_ARCHIVE = {
  module: '@tier0/opcua-client', version: '0.6.0',
  integrity: 'sha512-XR7rYjJvX3dQx1Z9d7OnmSSg4l3UdOPqKGc+px/+9voyXdXIhTXOtAMzN2VenLgloq+y6lXe55e92OC/YngMpg==',
} as const;

/** Archive verification covers extra standalone packages without changing the offline seed inputs. */
export const PROTOCOL_ARCHIVE_PINS = [...PROTOCOL_PACKAGE_PINS, CONTROLLED_OPCUA_ARCHIVE] as const;

/** Existing published component; ARM64 requires a separately qualified native build. */
export const CONTROLLED_OPCUA_REQUIREMENT: NodeRequirement = {
  module: CONTROLLED_OPCUA_ARCHIVE.module, version: CONTROLLED_OPCUA_ARCHIVE.version,
  nodeTypes: ['tier0-opcua-connection', 'tier0-opcua-read'],
};

export function protocolRequirement(module: string): NodeRequirement {
  const pin = PROTOCOL_PACKAGE_PINS.find((p) => p.module === module);
  if (!pin) throw new Error(`未知协议组件：${module}`);
  return { module: pin.module, version: pin.version, nodeTypes: [...pin.nodeTypes] };
}

const base = (id: string, name: string, builtinNodeTypes: string[]): ProtocolDefinition => ({
  id, name, category: 'network', status: 'available', description: 'Node-RED 基础通信节点',
  notes: ['设备地址、网络可达性和实际数据收发需单独验证。'], requirements: [], builtinNodeTypes,
});
const driver = (id: string, name: string, module: string): ProtocolDefinition => ({
  id, name, category: 'industrial', status: 'available', description: '按实例安装的固定版本协议组件',
  notes: ['先批准并下发节点策略，再显式安装；不会自动重启实例。', '已加载节点不等于设备采集或云端接入已验收。'],
  requirements: [protocolRequirement(module)], builtinNodeTypes: [],
});

export const PROTOCOL_COMPONENTS: readonly ProtocolDefinition[] = [
  base('tcp', 'TCP', ['tcp in', 'tcp out']),
  base('udp', 'UDP', ['udp in', 'udp out']),
  base('http', 'HTTP / HTTPS', ['http in', 'http response', 'http request']),
  driver('modbus-tcp', 'Modbus-TCP', 'node-red-contrib-modbus'),
  { ...driver('modbus-rtu', 'Modbus-RTU', 'node-red-contrib-modbus'), status: 'blocked',
    notes: ['受管实例尚未提供安全串口设备透传，安装节点包不会解除此限制。'] },
  driver('opcua', 'OPC UA', 'node-red-contrib-opcua'),
  { id: 'opcua-controlled', name: 'OPC UA 安全采集与控制', category: 'industrial', status: 'available',
    description: '现成 Node-RED 组件，读写与安全连接由组件负责',
    requirements: [CONTROLLED_OPCUA_REQUIREMENT], builtinNodeTypes: [],
    notes: ['固定 @tier0/opcua-client 0.6.0；ARM64 需使用本轮由原始发行源码构建的原生构件。',
      '仅已验证场景；不代表所有型号兼容。密码和私钥口令在 Node-RED 凭据中配置。'] },
  driver('s7', 'Siemens S7', 'node-red-contrib-s7'),
  ...(['coap', 'bacnet', 'iec104'] as const).map((id): ProtocolDefinition => ({
    id, name: { coap: 'CoAP', bacnet: 'BACnet', iec104: 'IEC 60870-5-104' }[id],
    category: id === 'bacnet' ? 'building' : id === 'iec104' ? 'power' : 'network',
    status: 'extension', description: '扩展候选，尚未提供已验证的固定驱动',
    notes: ['当前版本不提供可部署采集模板。'], requirements: [], builtinNodeTypes: [],
  })),
];

export function getProtocol(id: string): ProtocolDefinition | undefined {
  return PROTOCOL_COMPONENTS.find((protocol) => protocol.id === id);
}

function loadedTypes(module: string, types: string[], installed: readonly InstalledModule[]): string[] {
  return types.filter((type) => {
    const owners = installed.flatMap((m) => m.nodeSets.filter((set) => set.types.includes(type)));
    return owners.length === 1 && owners[0]!.module === module
      && owners[0]!.enabled && owners[0]!.enabledKnown !== false && owners[0]!.err === '';
  });
}

/** Pure evidence evaluation. Cache and approvals cannot stand in for runtime observations. */
export function protocolStatuses(
  facts: (requirement: NodeRequirement) => ProtocolPackageFacts,
  installed?: readonly InstalledModule[],
): ProtocolComponentStatus[] {
  return PROTOCOL_COMPONENTS.map((protocol) => {
    const blockers: string[] = [];
    if (protocol.status !== 'available') blockers.push(protocol.notes[0]!);
    const packages = protocol.requirements.map((requirement) => {
      const observed = installed?.find((m) => m.module === requirement.module);
      const exact = observed?.version === requirement.version
        && observed.observedVersions.length === 1 && observed.observedVersions[0] === requirement.version;
      const loaded = installed === undefined ? [] : loadedTypes(requirement.module, requirement.nodeTypes, installed);
      const missingNodeTypes = requirement.nodeTypes.filter((t) => !loaded.includes(t));
      const installation = installed === undefined ? 'not-inspected' as const
        : !observed ? 'not-observed' as const : !exact ? 'version-mismatch' as const : 'installed' as const;
      const ready = !!exact && observed.health === 'healthy' && missingNodeTypes.length === 0;
      if (installed !== undefined && !ready) blockers.push(`${requirement.module}@${requirement.version} 未确认完整加载`);
      return { ...requirement, ...facts(requirement), installedVersion: observed?.version || null,
        installation, loaded: installed === undefined ? null : ready, missingNodeTypes };
    });
    if (installed !== undefined && protocol.builtinNodeTypes.length > 0) {
      const loaded = loadedTypes('node-red', protocol.builtinNodeTypes, installed);
      if (loaded.length !== protocol.builtinNodeTypes.length) blockers.push('基础通信节点未确认完整加载');
    }
    return { ...protocol, packages, ready: installed === undefined ? null : blockers.length === 0, blockers };
  });
}
