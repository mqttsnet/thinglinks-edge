import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { NetworkIsolationError, containsAddress, validNetworkId } from './descriptor.ts';
import type { NetworkIsolationController } from './controller.ts';

export type NetworkControl = Pick<NetworkIsolationController, 'descriptor' | 'ready' | 'health' | 'profileState' | 'register' | 'unregister'>;
const MAX_BODY = 64 * 1024;
function send(reply: ServerResponse, status: number, value: unknown): void {
  if (reply.headersSent || reply.destroyed) return;
  reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  reply.end(JSON.stringify(value));
}
function peerAddress(address: string): string { return address.startsWith('::ffff:') ? address.slice(7) : address; }
function loopback(address: string): boolean { return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'); }
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new NetworkIsolationError('不支持压缩控制请求', 415);
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) { request.resume(); throw new NetworkIsolationError('控制请求过大', 413); }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => fail(new NetworkIsolationError('控制请求超时', 408)), 5000);
    const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', aborted); };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const aborted = () => fail(new NetworkIsolationError('控制请求已中断', 400));
    const data = (part: Buffer) => { size += part.length; if (size > MAX_BODY) { fail(new NetworkIsolationError('控制请求过大', 413)); return; } chunks.push(part); };
    const end = () => { cleanup(); try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new NetworkIsolationError('控制请求不是合法 JSON', 400)); } };
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', aborted);
  });
}
function handler(controller: NetworkControl, control: boolean) {
  let active = 0;
  const peers = new Map<string, number>(), scopes = new Map<string, number>();
  return (request: IncomingMessage, reply: ServerResponse) => {
    request.on('error', () => undefined);
    reply.on('error', () => { reply.destroy(); });
    void (async () => {
      let release: (() => void) | undefined;
      const admit = (scope = 'control'): boolean => {
        const peer = peerAddress(request.socket.remoteAddress ?? '');
        // HTTP pipelining can put many requests on one TCP connection. Both the
        // actual peer and its authorized source CIDR get a request budget, so a
        // single instance cannot occupy every shared kernel-readiness slot.
        if (active >= (control ? 8 : 32) || (!control && ((peers.get(peer) ?? 0) >= 4 || (scopes.get(scope) ?? 0) >= 4))) {
          request.resume(); send(reply, 429, { error: '网络保护服务繁忙' }); return false;
        }
        active++;
        if (!control) { peers.set(peer, (peers.get(peer) ?? 0) + 1); scopes.set(scope, (scopes.get(scope) ?? 0) + 1); }
        release = () => {
          active--;
          if (!control) {
            const peerLeft = (peers.get(peer) ?? 1) - 1, scopeLeft = (scopes.get(scope) ?? 1) - 1;
            if (peerLeft) peers.set(peer, peerLeft); else peers.delete(peer);
            if (scopeLeft) scopes.set(scope, scopeLeft); else scopes.delete(scope);
          }
        };
        return true;
      };
      try {
        const raw = request.url ?? '/';
        if (raw.length > 512 || !raw.startsWith('/') || /[\\#\0]/.test(raw)) throw new NetworkIsolationError('请求路径无效', 400);
        const url = new URL(raw, 'http://network-guard.invalid');
        if (request.method === 'GET' && url.pathname === '/healthz' && !url.search) {
          if (!control && !loopback(request.socket.remoteAddress ?? '')) { send(reply, 403, { error: '仅本机可查询服务健康' }); return; }
          if (!admit('healthz')) return;
          const health = await controller.health(); send(reply, health.supported && health.recovered ? 200 : 503, health); return;
        }
        if (!control) {
          if (request.method !== 'GET' || url.pathname !== '/ready') { request.resume(); send(reply, 404, { error: '只读入口不存在' }); return; }
          if ([...url.searchParams.keys()].length !== 1 || !validNetworkId(url.searchParams.get('network'))) throw new NetworkIsolationError('网络标识无效', 400);
          const id = url.searchParams.get('network')!, descriptor = controller.descriptor(id);
          // Reject before any admission or kernel work. Neither a forged header
          // nor cycling through unknown IDs can obtain additional request slots.
          if (!descriptor) { send(reply, 503, { ready: false, networkId: id, state: 'unregistered' }); return; }
          if (!containsAddress(descriptor.cidr, request.socket.remoteAddress ?? '')) { send(reply, 403, { ready: false, networkId: id }); return; }
          if (!admit(`cidr:${descriptor.cidr}`)) return;
          const ready = await controller.ready(id);
          send(reply, ready ? 200 : 503, { ready, networkId: id, state: controller.profileState(id) }); return;
        }
        if (url.search) throw new NetworkIsolationError('控制请求不接受查询参数', 400);
        if (!admit()) return;
        if (request.method === 'POST' && url.pathname === '/networks/register') { send(reply, 200, await controller.register(await readJson(request))); return; }
        const match = /^\/networks\/([a-f0-9]{64})(\/ready)?$/.exec(url.pathname);
        if (match && request.method === 'GET' && match[2]) {
          const ready = await controller.ready(match[1]!); send(reply, ready ? 200 : 503, { ready, networkId: match[1], state: controller.profileState(match[1]!) }); return;
        }
        if (match && request.method === 'DELETE' && !match[2]) { send(reply, 200, await controller.unregister(match[1]!)); return; }
        request.resume(); send(reply, 404, { error: '控制入口不存在' });
      } catch (error) {
        request.resume(); send(reply, error instanceof NetworkIsolationError ? error.status : 503,
          { error: error instanceof NetworkIsolationError ? error.message : '网络保护操作未完成' });
      } finally { release?.(); }
    })();
  };
}

async function prepareSocket(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 100) throw new NetworkIsolationError('控制 socket 路径无效');
  const parent = dirname(path); await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(parent) !== parent) throw new NetworkIsolationError('控制 socket 必须使用独立真实目录');
  await chmod(parent, 0o700);
  let previous;
  try { previous = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new NetworkIsolationError('控制 socket 路径已被占用');
  const live = await new Promise<boolean>((resolveLive, reject) => {
    const client = createConnection(path);
    client.setTimeout(500);
    client.once('connect', () => { client.destroy(); resolveLive(true); });
    client.once('timeout', () => { client.destroy(); reject(new NetworkIsolationError('无法确认旧控制 socket 状态')); });
    client.once('error', error => { if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolveLive(false); else reject(error); });
  });
  if (live) throw new NetworkIsolationError('网络保护服务已经运行');
  const current = await lstat(path);
  if (current.dev !== previous.dev || current.ino !== previous.ino || !current.isSocket()) throw new NetworkIsolationError('控制 socket 在核验期间发生变化');
  await unlink(path);
}

export async function startNetworkIsolationServers(controller: NetworkControl, options: { controlSocket: string; healthHost: string; healthPort: number }): Promise<{ healthPort: number; close(): Promise<void> }> {
  await prepareSocket(options.controlSocket);
  const control = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10000, headersTimeout: 5000 }, handler(controller, true));
  const health = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, handler(controller, false));
  const sockets = new Set<Socket>(), sources = new Map<string, number>();
  control.maxConnections = 16; health.maxConnections = 1024;
  for (const server of [control, health]) {
    server.maxRequestsPerSocket = 100;
    server.on('connection', socket => {
      socket.on('error', () => { socket.destroy(); });
      const peer = peerAddress(socket.remoteAddress ?? 'local');
      if (server === health && (sources.get(peer) ?? 0) >= 4) { socket.destroy(); return; }
      if (server === health) sources.set(peer, (sources.get(peer) ?? 0) + 1);
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); if (server === health) { const left = (sources.get(peer) ?? 1) - 1; if (left) sources.set(peer, left); else sources.delete(peer); } });
    });
    server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  }
  const close = async () => {
    // Let bounded request bodies drain before closing clients that already got a
    // rejection response. Immediate destroy here races their outstanding writes.
    const force = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1000);
    force.unref();
    try { await Promise.all([control, health].map(server => new Promise<void>(resolveDone => server.close(() => resolveDone())))); }
    finally { clearTimeout(force); }
  };
  const listen = (server: Server, target: string | { host: string; port: number }) => new Promise<void>((resolveListen, reject) => {
    server.once('error', reject); server.listen(target, () => { server.off('error', reject); resolveListen(); });
  });
  try {
    await listen(control, options.controlSocket); await chmod(options.controlSocket, 0o600);
    await listen(health, { host: options.healthHost, port: options.healthPort });
    const address = health.address();
    if (!address || typeof address === 'string') throw new NetworkIsolationError('网络保护健康端口未启动');
    return { healthPort: address.port, close };
  } catch (error) { await close(); throw error; }
}
