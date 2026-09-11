import { randomUUID } from 'node:crypto';
import { parseFlows } from './parse.ts';
import { TemplateError, type FlowNode } from './types.ts';

/** Explicit node schemas avoid accidentally rewriting payload, source code or addresses. */
const CONFIG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'mqtt in': ['broker'], 'mqtt out': ['broker'], 'mqtt-broker': ['tls'],
  'tcp in': ['tls'], 'tcp out': ['tls'], 'tcp request': ['tls'],
  'http request': ['tls', 'proxy'],
  'websocket in': ['client', 'server'], 'websocket out': ['client', 'server'],
  'websocket-client': ['tls'],
  'modbus-read': ['server'], 'modbus-getter': ['server'], 'modbus-flex-getter': ['server'],
  'modbus-write': ['server'], 'modbus-flex-write': ['server'],
  'OpcUa-Client': ['endpoint'], 's7 in': ['endpoint'], 's7 out': ['endpoint'],
  'tier0-opcua-read': ['connection'], 'tier0-opcua-write': ['connection'],
};
const LITERAL_FIELDS = new Set([
  'id', 'type', 'label', 'name', 'info', 'func', 'initialize', 'finalize',
  'payload', 'topic', 'url', 'host', 'address', 'nodeId', 'device', 'serviceCode',
]);

/**
 * Copy an imported graph. Unknown config schemas fail closed instead of guessing.
 * Extend CONFIG_FIELDS when supporting another node type's config references.
 */
export function appendFlows(
  currentInput: unknown,
  incomingInput: unknown,
  newId: (oldId: string) => string = () => randomUUID().replaceAll('-', ''),
): FlowNode[] {
  const current = parseFlows(currentInput);
  const incoming = parseFlows(incomingInput);
  if (current.length + incoming.length > 50_000) throw new TemplateError('追加后节点总数超过 50000');
  const allocated = new Set(current.map((node) => node.id));
  const references = new Set([...allocated, ...incoming.map((node) => node.id)]);
  const ids = new Map<string, string>();
  for (const node of incoming) {
    const id = newId(node.id);
    if (!id || allocated.has(id)) throw new TemplateError('追加流程生成的节点 id 重复或为空');
    allocated.add(id);
    ids.set(node.id, id);
  }
  const configIds = new Set(incoming.filter((n) => !n.z && !['tab', 'subflow', 'group'].includes(n.type)).map((n) => n.id));
  const ref = (value: unknown): unknown => {
    if (value === '' || value === undefined || value === null) return value;
    if (typeof value !== 'string' || !references.has(value)) throw new TemplateError(`追加流程有无法解析的节点引用：${String(value)}`);
    return ids.get(value) ?? value;
  };
  const refList = (value: unknown): unknown => Array.isArray(value) ? value.map(ref) : ref(value);
  const remapPort = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TemplateError('子流程端口格式无效');
    const port = value as Record<string, unknown>;
    if (Array.isArray(port['wires'])) {
      port['wires'] = port['wires'].map((wire: unknown) => {
        if (!wire || typeof wire !== 'object' || Array.isArray(wire)) throw new TemplateError('子流程连线格式无效');
        const record = wire as Record<string, unknown>;
        return { ...record, id: ref(record['id']) };
      });
    }
    return port;
  };
  const imported = structuredClone(incoming);
  for (const node of imported) {
    const configFields = Object.hasOwn(CONFIG_FIELDS, node.type) ? CONFIG_FIELDS[node.type]! : [];
    for (const [key, value] of Object.entries(node)) {
      if (!LITERAL_FIELDS.has(key) && !['z', 'g'].includes(key) && !configFields.includes(key)
          && typeof value === 'string' && configIds.has(value)) {
        throw new TemplateError(`节点 ${node.type} 的配置引用字段 ${key} 尚不支持安全追加，请补充节点引用定义或使用整体替换`);
      }
    }
    node.id = ids.get(node.id)!;
    for (const key of ['z', 'g', ...configFields]) {
      if (node[key] !== undefined) node[key] = ref(node[key]);
    }
    if (Array.isArray(node['wires'])) node['wires'] = node['wires'].map(refList);
    for (const key of ['links', 'scope']) {
      if (Array.isArray(node[key])) node[key] = refList(node[key]);
    }
    if (node.type === 'group' && Array.isArray(node['nodes'])) node['nodes'] = refList(node['nodes']);
    if (node.type.startsWith('subflow:')) node.type = `subflow:${ref(node.type.slice(8))}`;
    if (node.type === 'subflow') {
      for (const key of ['in', 'out']) {
        if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map(remapPort);
      }
      if (node['status']) node['status'] = remapPort(node['status']);
    }
  }
  return [...current, ...imported];
}
