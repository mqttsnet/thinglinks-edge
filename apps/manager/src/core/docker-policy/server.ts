import {
  Agent, createServer, request as httpRequest,
  type IncomingMessage, type RequestOptions, type Server, type ServerResponse,
} from 'node:http';
import { DockerExecutionPolicy, type AuthorizedRequest } from './policy.ts';
import { demand, object, PolicyDenied, validatePolicyConfig, type PolicyConfig } from './config.ts';
import { join } from 'node:path';
import { NetworkIntentStore } from './network-intents.ts';
import { NetworkCoordinator } from './network-coordinator.ts';
import { UnixNetworkGuardClient, type NetworkGuardClient } from './network-guard.ts';
import { authorizeRestorePeer, restoreWriterSnapshot, RESTORE_WRITERS_PATH } from './restore-maintenance.ts';

const MAX_REQUEST_BYTES = 4 * 1024 ** 2;
const MAX_JSON_BYTES = 8 * 1024 ** 2;
const REQUEST_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT = 16;
const MAX_LOG_STREAMS = 4;

/** Production uses socketPath only. Host/port exist for isolated fake-daemon integration tests. */
export type DaemonConnection = { socketPath: string } | { hostname: string; port: number };

function failure(response: ServerResponse, status: number): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, {
    'content-type': 'application/json',
    // Drain an oversized request without buffering it, so the caller can receive 413
    // instead of losing the response to an EPIPE while its upload is in flight.
    ...(status === 413 ? {} : { connection: 'close' }),
  });
  response.end(JSON.stringify({ message: status === 403 ? 'Docker operation denied by instance isolation policy' : 'Docker operation unavailable' }));
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new PolicyDenied(408)), 10_000);
    const clean = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => { clean(); request.resume(); reject(error); };
    const abort = () => fail(new PolicyDenied(408));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { fail(new PolicyDenied(413)); return; }
      chunks.push(chunk);
    };
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function responseBytes(response: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > max) throw new PolicyDenied(502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class DaemonConnectionClient {
  private readonly connection: DaemonConnection;
  private readonly agent = new Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT, maxFreeSockets: 4 });
  constructor(connection: DaemonConnection) { this.connection = connection; }
  close(): void { this.agent.destroy(); }

  request(plan: AuthorizedRequest, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {};
      if (plan.body) { headers['content-type'] = plan.contentType ?? 'application/json'; headers['content-length'] = plan.body.length; }
      const options: RequestOptions = { ...this.connection, method: plan.method, path: plan.path, headers, agent: this.agent, signal };
      const request = httpRequest(options, resolve);
      request.on('error', reject);
      request.end(plan.body);
    });
  }

  async json(path: string, parentSignal: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    const response = await this.request({ method: 'GET', path }, signal);
    if ((response.statusCode ?? 500) >= 400) {
      response.destroy(); throw new PolicyDenied(response.statusCode === 404 ? 404 : 502);
    }
    return JSON.parse((await responseBytes(response, MAX_JSON_BYTES)).toString('utf8'));
  }
}

function normalizeIp(ip: string): string { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }

async function authorizePeer(config: PolicyConfig, client: DaemonConnectionClient, request: IncomingMessage, signal: AbortSignal): Promise<string | undefined> {
  const manager = object(await client.json(`/containers/${config.managerContainer}/json`, signal));
  demand(manager['Name'] === `/${config.managerContainer}`);
  const networks = object(object(manager['NetworkSettings'])['Networks']);
  const peer = normalizeIp(request.socket.remoteAddress ?? '');
  const state = object(manager['State']);
  if (state['Running'] === true && peer && Object.values(networks).some(value => {
    const network = object(value);
    return [network['IPAddress'], network['GlobalIPv6Address']].some(ip => typeof ip === 'string' && ip.length > 0 && normalizeIp(ip) === peer);
  })) return undefined;
  // A oneoff never receives normal Manager authority, including on GET routes.
  demand(request.method === 'GET' && request.url === RESTORE_WRITERS_PATH && peer);
  return authorizeRestorePeer(config, { json: path => client.json(path, signal) }, manager, peer);
}

/** No request headers, arbitrary paths, or failed daemon response bodies are forwarded. */
export function createDockerPolicyServer(config: PolicyConfig, connection: DaemonConnection, dependencies: {
  networkGuard?: NetworkGuardClient;
  networkIntents?: Pick<NetworkIntentStore, 'begin' | 'recordCreated' | 'pending' | 'commit'>;
  recoveryRetry?: { initialMs: number; maxMs: number };
} = {}): Server {
  validatePolicyConfig(config);
  const client = new DaemonConnectionClient(connection);
  const intentStore = dependencies.networkIntents ?? new NetworkIntentStore(join(config.stateRoot, 'network-intents'));
  const networks = new NetworkCoordinator(config, {
    json: (path, signal = AbortSignal.timeout(30_000)) => client.json(path, signal),
    deleteNetwork: async (networkId, signal = AbortSignal.timeout(30_000)) => {
      const result = await client.request({ method: 'DELETE', path: `/networks/${networkId}` }, signal);
      const status = result.statusCode;
      result.destroy();
      if (status !== 204 && status !== 200 && status !== 404) throw new PolicyDenied(503);
    },
  }, dependencies.networkGuard ?? new UnixNetworkGuardClient(config.networkSocket), intentStore);
  let recoveryComplete = false;
  const retry = dependencies.recoveryRetry ?? { initialMs: 1000, maxMs: 30_000 };
  demand(Number.isSafeInteger(retry.initialMs) && retry.initialMs > 0 && Number.isSafeInteger(retry.maxMs)
    && retry.maxMs >= retry.initialMs && retry.maxMs <= 60_000);
  const recoveryAbort = new AbortController();
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryRunning = false, recoveryWarned = false, recoveryDelay = retry.initialMs;
  let active = 0, logStreams = 0;
  let mutationTail = Promise.resolve();
  const takeMutation = async (signal: AbortSignal): Promise<() => void> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new PolicyDenied(408));
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) reject(new PolicyDenied(408)); else resolve();
        });
      });
      return release;
    } catch (error) {
      // An abandoned queued request must release its position after its predecessor.
      void previous.then(release);
      throw error;
    }
  };
  const queueRecovery = () => {
    if (recoveryAbort.signal.aborted || recoveryTimer || recoveryRunning) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void runRecovery();
    }, recoveryDelay);
    recoveryTimer.unref();
    recoveryDelay = Math.min(retry.maxMs, recoveryDelay * 2);
  };
  const runRecovery = async (): Promise<void> => {
    if (recoveryAbort.signal.aborted || recoveryRunning) return;
    recoveryRunning = true;
    let release: (() => void) | undefined;
    let outcome: { pending: number } | undefined;
    try {
      const signal = AbortSignal.any([recoveryAbort.signal, AbortSignal.timeout(60_000)]);
      release = await takeMutation(signal);
      outcome = await networks.recoverPending(signal);
      recoveryComplete = true;
      if (outcome.pending === 0) { recoveryDelay = retry.initialMs; recoveryWarned = false; }
    } catch {
      if (!recoveryAbort.signal.aborted && !recoveryWarned) {
        console.error('Docker network recovery is temporarily unavailable; retrying with bounded backoff');
        recoveryWarned = true;
      }
    } finally {
      release?.(); recoveryRunning = false;
      if (!outcome || outcome.pending > 0) queueRecovery();
    }
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const isLogs = /\/logs(?:\?|$)/.test(request.url ?? '');
    if (active >= MAX_CONCURRENT || (isLogs && logStreams >= MAX_LOG_STREAMS)) { failure(response, 429); request.resume(); return; }
    active++; if (isLogs) logStreams++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onClose = () => { if (!response.writableFinished) controller.abort(); };
    let releaseMutation: (() => void) | undefined;
    let plan: AuthorizedRequest | undefined, dispatched = false;
    response.once('close', onClose);
    request.once('aborted', () => controller.abort());
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        demand(['127.0.0.1', '::1'].includes(normalizeIp(request.socket.remoteAddress ?? '')));
        response.writeHead(recoveryComplete ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: recoveryComplete, pendingNetworkOperations: intentStore.pending().length })); return;
      }
      demand(request.headers['content-encoding'] === undefined || request.headers['content-encoding'] === 'identity');
      const length = Number(request.headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) throw new PolicyDenied(413);
      const maintenanceId = await authorizePeer(config, client, request, controller.signal);
      const body = await readBody(request, controller.signal);
      if (request.method === 'GET' && request.url === RESTORE_WRITERS_PATH) {
        demand(body.length === 0);
        const snapshot = await restoreWriterSnapshot(config,
          { json: path => client.json(path, controller.signal) }, maintenanceId);
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(snapshot));
        return;
      }
      demand(maintenanceId === undefined);
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        if (!recoveryComplete) throw new PolicyDenied(503);
        releaseMutation = await takeMutation(controller.signal);
      }
      const policy = new DockerExecutionPolicy(config, { json: path => client.json(path, controller.signal) }, networks, controller.signal);
      plan = await policy.authorize({ method: request.method ?? '', path: request.url ?? '', body });
      if (plan.beforeForward) await plan.beforeForward();
      controller.signal.throwIfAborted();
      dispatched = true;
      const upstream = await client.request(plan, controller.signal);
      const status = upstream.statusCode ?? 502;
      if (status >= 400) { upstream.destroy(); throw new PolicyDenied(status); }
      const contentType = upstream.headers['content-type'];
      response.statusCode = status;
      if (contentType) response.setHeader('content-type', contentType);
      if (plan.afterForward) {
        const bytes = await responseBytes(upstream, MAX_JSON_BYTES);
        await plan.afterForward(bytes.length ? JSON.parse(bytes.toString('utf8')) : {});
        response.end(bytes); return;
      }
      if (plan.transform) {
        const value = await plan.transform(JSON.parse((await responseBytes(upstream, MAX_JSON_BYTES)).toString('utf8')));
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); return;
      }
      // Streaming logs use a bounded lifetime and backpressure. They cannot buffer without limit.
      let bytes = 0;
      for await (const chunk of upstream) {
        bytes += chunk.length;
        if (bytes > (isLogs ? 32 * 1024 ** 2 : MAX_JSON_BYTES)) throw new PolicyDenied(502);
        if (!response.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { response.off('drain', drain); reject(new PolicyDenied(408)); };
            const drain = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
            response.once('drain', drain); controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          });
        }
      }
      response.end();
    } catch (error) {
      let status = error instanceof PolicyDenied ? error.statusCode : 502;
      if (plan?.onFailure) {
        try { await plan.onFailure(dispatched); }
        catch {
          status = 503;
          // Leave the exact intent intact and schedule another ownership-checked
          // attempt. Unrelated reads stay available and only this network is fenced.
          queueRecovery();
        }
      }
      if (!response.destroyed) failure(response, status);
    } finally {
      request.resume(); clearTimeout(timeout); response.off('close', onClose);
      active--; if (isLogs) logStreams--;
      releaseMutation?.();
    }
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response).catch(() => failure(response, 502));
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.on('close', () => {
    recoveryAbort.abort(); if (recoveryTimer) clearTimeout(recoveryTimer);
    client.close();
  });
  void runRecovery();
  return server;
}
