import type { FlowNode } from './types.ts';

type Listener = { kind: 'tcp' | 'udp' | 'http'; address: string; method?: string; name: string };
function listeners(flows: FlowNode[]): Listener[] {
  const disabledTabs = new Set(flows.filter((n) => n.type === 'tab' && n['disabled'] === true).map((n) => n.id));
  return flows.flatMap((node): Listener[] => {
    if (node['d'] === true || (node.z && disabledTabs.has(node.z))) return [];
    const name = node.name || node.id;
    if (node.type === 'tcp in' && node['server'] === 'server' && node['port']) {
      return [{ kind: 'tcp', address: String(node['port']), name }];
    }
    if (node.type === 'udp in' && node['port']) return [{ kind: 'udp', address: String(node['port']), name }];
    if (node.type === 'http in' && typeof node['url'] === 'string') {
      return [{ kind: 'http', address: node['url'].replace(/\/+$/, '') || '/', method: String(node['method'] ?? 'get').toLowerCase(), name }];
    }
    return [];
  });
}

/** Same-instance conflicts only. Host port exposure and other processes require runtime validation. */
export function listenerConflicts(current: FlowNode[], incoming: FlowNode[]): string[] {
  const seen = listeners(current);
  const issues: string[] = [];
  for (const listener of listeners(incoming)) {
    const conflict = seen.find((other) => other.kind === listener.kind && other.address === listener.address
      && (listener.kind !== 'http' || other.method === listener.method || other.method === 'all' || listener.method === 'all'));
    if (conflict) issues.push(listener.kind === 'http'
      ? `HTTP 路径 ${listener.address} 已由 ${conflict.name} 使用，请修改接收路径`
      : `${listener.kind.toUpperCase()} 监听端口 ${listener.address} 已由 ${conflict.name} 使用，请修改端口`);
    seen.push(listener);
  }
  return [...new Set(issues)];
}
