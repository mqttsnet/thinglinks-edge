/** Bind device credentials to the deployed Node-RED configuration, not just a reusable URL. */
import { createHash } from 'node:crypto';
import { getFlowSnapshot, type FlowSnapshot } from '../../../core/flows/admin-client.ts';
import type { FlowNode } from '../../../core/flows/types.ts';
import type { HttpContext } from '../../context.ts';
import { IngressError } from './types.ts';
import { ingressSessions } from './session.ts';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]),
  );
  return value;
}

export function flowRevision(snapshot: FlowSnapshot): string {
  return JSON.stringify({ rev: snapshot.rev, sha256: createHash('sha256').update(JSON.stringify(stable(snapshot.flows))).digest('hex') });
}

export function validateManagedHttpFlow(snapshot: FlowSnapshot, adminRoot: string, targetPath: string, deviceId: string): void {
  const nodes = new Map<string, FlowNode>();
  for (const node of snapshot.flows) {
    if (nodes.has(node.id)) throw new IngressError(400, '实例流程含重复节点标识');
    nodes.set(node.id, node);
  }
  const enabled = (node: FlowNode): boolean => {
    if (node.d === true || node.disabled === true) return false;
    const tab = node.z ? nodes.get(node.z) : undefined;
    return tab?.type === 'tab' && tab.disabled !== true;
  };
  const root = `${adminRoot.replace(/\/$/, '')}/api`;
  const path = targetPath.slice(root.length);
  const inputs = snapshot.flows.filter(node => node.type === 'http in' && enabled(node)
    && String(node.method).toLowerCase() === 'post');
  // Dynamic Express routes can shadow a literal path depending on deployment
  // order. Until that routing behavior is modeled, accept only fixed paths.
  if (inputs.some(node => typeof node.url !== 'string' || !/^\/[A-Za-z0-9._~/-]+$/.test(node.url)
    || node.url.includes('//') || node.url.split('/').some(segment => segment === '.' || segment === '..'))) {
    throw new IngressError(400, '设备入口仅支持实例内使用固定 POST 路径的纳管 HTTP 流程');
  }
  // Express may treat case and a trailing slash as equivalent. Never let a
  // second device's earlier route registration win an otherwise literal match.
  const routeKey = (value: string) => value.replace(/\/$/, '').toLowerCase();
  const matching = inputs.filter(node => routeKey(node.url as string) === routeKey(path));
  if (matching.length !== 1) throw new IngressError(400, '请先部署唯一的 HTTP 推送流程，再创建设备入口');
  if (matching[0]!.url !== path) throw new IngressError(400, '入口路径必须与已部署 HTTP 路径完全一致');
  const seen = new Set<string>();
  const pending = [matching[0]!.id];
  const devices = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node || !enabled(node)) throw new IngressError(400, 'HTTP 流程包含缺失或禁用的连接节点');
    if (node.type.startsWith('link ') || node.type.startsWith('subflow:')) throw new IngressError(400, '入口暂不支持跨流程链接或子流程，请使用已部署的纳管 HTTP 模板');
    if (node.type === 'tl-device') {
      if (node.deviceId !== deviceId) throw new IngressError(400, 'HTTP 流程的设备标识与入口绑定不一致');
      devices.add(node.id);
    }
    const wires = node.wires;
    if (wires === undefined) continue;
    if (!Array.isArray(wires) || wires.some(output => !Array.isArray(output) || output.some(id => typeof id !== 'string'))) {
      throw new IngressError(400, 'HTTP 流程连线格式无效');
    }
    pending.push(...wires.flat() as string[]);
  }
  if (devices.size !== 1) throw new IngressError(400, 'HTTP 路径必须连接一个且仅一个匹配设备标识的 tl-device 节点');
}

/** Use the shared native v2 client with a fail-closed bounded transport wrapper. */
export async function readBoundRevision(ctx: HttpContext, instanceId: string, targetPath: string, deviceId: string, expectedRevision?: string): Promise<string> {
  const target = ctx.adminRuntime.target(instanceId);
  const instance = ctx.repo.get(instanceId);
  const origin = new URL(ctx.upstreamFor(instanceId));
  if (!instance || target.adminRoot !== instance.adminRoot || target.upstream !== origin.origin) {
    throw new IngressError(502, '实例管理目标与设备入口不一致');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const sessions = ingressSessions(ctx);
  const credentialVersion = createHash('sha256').update(ctx.repo.key).update(instance.credSecret ?? '').digest('hex');
  try {
    const authUrl = `${target.upstream}${target.adminRoot}auth/token`;
    const flowsUrl = `${target.upstream}${target.adminRoot}flows`;
    const boundedFetch: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url !== authUrl && url !== flowsUrl) throw new IngressError(502, '设备入口不能访问此实例管理路径');
      if (url === authUrl) {
        const token = await sessions.get(instanceId, target, credentialVersion, controller.signal);
        return Response.json({ access_token: token });
      }
      if (url === flowsUrl && !new Headers(init.headers).get('authorization')?.startsWith('Bearer ')) {
        throw new IngressError(502, '设备入口读取流程必须通过实例认证');
      }
      const request = (headers: Headers) => fetch(input, {
        ...init, headers, redirect: 'manual',
        signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      });
      const headers = new Headers(init.headers);
      let response = await request(headers);
      if (response.status === 401) {
        await response.body?.cancel();
        await sessions.invalidate(instanceId, headers.get('authorization')!.slice('Bearer '.length));
        const token = await sessions.get(instanceId, target, credentialVersion, controller.signal);
        headers.set('authorization', `Bearer ${token}`);
        response = await request(headers);
        // A rejected replacement is cleared, but this read never retries twice.
        if (response.status === 401) await sessions.invalidate(instanceId, token);
      }
      if (!response.ok) { await response.body?.cancel(); throw new IngressError(502, '无法认证或读取实例流程'); }
      const reader = response.body?.getReader();
      if (!reader) throw new IngressError(502, '实例流程响应为空');
      const max = 1048576;
      let bytes = 0; const parts: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > max) { await reader.cancel(); throw new IngressError(502, '实例流程响应超过安全读取上限'); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return new Response(Buffer.concat(parts), { status: response.status, headers: { 'content-type': 'application/json' } });
    };
    let snapshot: FlowSnapshot;
    try { snapshot = await getFlowSnapshot(target, boundedFetch, 5000); }
    catch { throw new IngressError(502, '无法安全读取实例流程，请检查实例认证、运行状态及流程大小'); }
    const revision = flowRevision(snapshot);
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new IngressError(409, '实例流程版本已变化，请核对设备映射并在设备入口页面确认当前流程');
    }
    validateManagedHttpFlow(snapshot, target.adminRoot, targetPath, deviceId);
    return revision;
  } finally { clearTimeout(timer); controller.abort(); }
}
