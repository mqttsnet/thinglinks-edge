import { assertContainerIsolation, assertContainerRuntimeIsolation } from '../instance/container-isolation.ts';
import { tarFile, untar } from '../archive/tar.ts';
import { assertInstanceResourceBudget } from '../instance/resource-budget.ts';
import { demand, deploymentRealm, keys, object, PolicyDenied, validatePolicyConfig, type PolicyConfig } from './config.ts';
import {
  MANAGED, ownerFromLabels, sameOwner, assertOwnedDirectory, assertSettingsTarget, type Owner,
} from './ownership.ts';
import type { NetworkCoordinator } from './network-coordinator.ts';
import { NETWORK_POLICY_REALM_LABEL } from './network-intents.ts';

export { PolicyDenied, type PolicyConfig } from './config.ts';

export interface DaemonReader { json(path: string): Promise<unknown> }
export interface PolicyRequest { method: string; path: string; body: Buffer }
export interface AuthorizedRequest {
  method: string;
  path: string;
  body?: Buffer;
  contentType?: string;
  transform?: (value: unknown) => unknown | Promise<unknown>;
  /** Repeat checks immediately before dispatch, after any other authorization awaits. */
  beforeForward?: () => Promise<void>;
  afterForward?: (body: unknown) => Promise<void>;
  onFailure?: (dispatched: boolean) => Promise<void>;
}

const ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function route(path: string): { pathname: string; params: URLSearchParams } {
  demand(path.startsWith('/') && path.length <= 4096 && !/[\\\r\n#]/.test(path));
  const raw = path.split('?')[0]!;
  demand(!raw.includes('//') && !/(^|\/)(\.|\.\.)(\/|$)/.test(raw) && !/%2e|%2f|%5c/i.test(raw));
  const pathname = raw.replace(/^\/v1\.\d+(?=\/)/, '');
  const params = new URLSearchParams(path.slice(raw.length + (path.includes('?') ? 1 : 0)));
  demand([...params.keys()].length === new Set(params.keys()).size);
  return { pathname, params };
}

function query(params: URLSearchParams, allowed: readonly string[]): void {
  demand([...params.keys()].every(key => allowed.includes(key)));
}

function pathWithQuery(path: string, params: URLSearchParams): string {
  return params.size ? `${path}?${params}` : path;
}

function jsonBody(body: Buffer): Record<string, unknown> {
  demand(body.length > 0 && body.length <= 1024 ** 2);
  return object(JSON.parse(body.toString('utf8')));
}

function writePlan(method: string, path: string, value: unknown): AuthorizedRequest {
  return { method, path, body: Buffer.from(JSON.stringify(value)), contentType: 'application/json' };
}

function resourceRef(value: string): string { demand(REF.test(value)); return value; }

/** Independent server-side authorization. No Manager database or request-supplied policy is trusted. */
export class DockerExecutionPolicy {
  private readonly config: PolicyConfig;
  private readonly daemon: DaemonReader;
  private readonly networks: Pick<NetworkCoordinator, 'ready' | 'prepareCreate' | 'prepareDelete'>;
  private readonly signal: AbortSignal | undefined;
  constructor(config: PolicyConfig, daemon: DaemonReader, networks: Pick<NetworkCoordinator, 'ready' | 'prepareCreate' | 'prepareDelete'>, signal?: AbortSignal) {
    validatePolicyConfig(config);
    this.config = structuredClone(config); this.daemon = daemon; this.networks = networks; this.signal = signal;
  }

  async authorize(request: PolicyRequest): Promise<AuthorizedRequest> {
    try { return await this.authorizeRequest(request); }
    catch (error) {
      if (error instanceof PolicyDenied) throw error;
      throw new PolicyDenied((error as { statusCode?: unknown })?.statusCode === 404 ? 404 : 403);
    }
  }

  private async approvedImage(reference: unknown): Promise<string> {
    demand(typeof reference === 'string');
    const allowed = this.config.allowedTags.map(tag => `${this.config.imageRepo}:${tag}`);
    if (allowed.includes(reference)) {
      const image = object(await this.daemon.json(`/images/${encodeURI(reference)}/json`));
      demand(typeof image['Id'] === 'string' && IMAGE_ID.test(image['Id']));
      return image['Id'];
    }
    demand(IMAGE_ID.test(reference));
    if (this.config.allowedImageIds.includes(reference)) {
      const image = object(await this.daemon.json(`/images/${reference}/json`));
      demand(image['Id'] === reference); return reference;
    }
    for (const candidate of allowed) {
      try {
        const image = object(await this.daemon.json(`/images/${encodeURI(candidate)}/json`));
        if (image['Id'] === reference) return reference;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    throw new PolicyDenied();
  }

  private async admitResources(requestedHost: Record<string, unknown>, replacingId?: string): Promise<void> {
    const info = object(await this.daemon.json('/info'));
    const filters = encodeURIComponent(JSON.stringify({ label: [`${MANAGED}=true`] }));
    const listed = await this.daemon.json(`/containers/json?all=true&filters=${filters}`);
    demand(Array.isArray(listed) && listed.length <= 4096);
    const reservations: Array<{ memLimit: number; cpuLimit: number }> = [];
    for (const entry of listed) {
      const item = object(entry), id = item['Id'];
      demand(typeof id === 'string' && ID.test(id));
      if (id === replacingId) continue;
      const container = object(await this.daemon.json(`/containers/${id}/json`));
      const labels = object(container['Config'])['Labels'];
      const owner = ownerFromLabels(labels, this.config, true);
      // Separate Edge deployments may share one daemon. Only reserve this data root;
      // external host workloads are covered by capacity headroom, not a claimed quota.
      const host = object(container['HostConfig']);
      if (container['Name'] !== `/${owner.containerName}` || !Array.isArray(host['Binds'])
        || !host['Binds'].includes(`${owner.dataDirectory}:/data`)) continue;
      reservations.push({ memLimit: Number(host['Memory']) / 1024 ** 2, cpuLimit: Number(host['NanoCpus']) / 1e9 });
    }
    assertInstanceResourceBudget({ memTotalMb: Math.floor(Number(info['MemTotal']) / 1024 ** 2), cpuCount: Number(info['NCPU']) },
      reservations, { memoryMb: Number(requestedHost['Memory']) / 1024 ** 2, cpus: Number(requestedHost['NanoCpus']) / 1e9 });
  }

  private async network(reference: string): Promise<{ info: Record<string, unknown>; owner: Owner; id: string }> {
    const info = object(await this.daemon.json(`/networks/${resourceRef(reference)}`));
    const owner = ownerFromLabels(info['Labels'], this.config, true);
    const realm = object(info['Labels'])[NETWORK_POLICY_REALM_LABEL];
    demand(realm === undefined || realm === deploymentRealm(this.config));
    demand(typeof info['Id'] === 'string' && ID.test(info['Id'])
      && info['Name'] === owner.networkName && info['Driver'] === 'bridge'
      && (owner.probe ? info['Internal'] === true : info['Internal'] !== true));
    return { info, owner, id: info['Id'] };
  }

  private async manager(reference: string): Promise<string | undefined> {
    if (reference !== this.config.managerContainer && !ID.test(reference)) return undefined;
    const info = object(await this.daemon.json(`/containers/${this.config.managerContainer}/json`));
    demand(typeof info['Id'] === 'string' && ID.test(info['Id']) && info['Name'] === `/${this.config.managerContainer}`);
    return reference === this.config.managerContainer || reference === info['Id'] ? info['Id'] : undefined;
  }

  private async container(reference: string): Promise<{ info: Record<string, unknown>; owner: Owner; id: string }> {
    const info = object(await this.daemon.json(`/containers/${resourceRef(reference)}/json`));
    const config = object(info['Config']);
    const owner = ownerFromLabels(config['Labels'], this.config, true);
    demand(typeof info['Id'] === 'string' && ID.test(info['Id']) && info['Name'] === `/${owner.containerName}`);
    const host = object(info['HostConfig']);
    demand(Array.isArray(host['Binds']) && host['Binds'].length === 1 && host['Binds'][0] === `${owner.dataDirectory}:/data`);
    const mounts = info['Mounts'];
    demand(Array.isArray(mounts) && mounts.length === 1);
    const mount = object(mounts[0]);
    demand(mount['Type'] === 'bind' && mount['Source'] === owner.dataDirectory && mount['Destination'] === '/data');
    // Names plus ownership labels alone cannot authorize a privileged or foreign filesystem container.
    demand(host['Privileged'] !== true && host['ReadonlyRootfs'] === true
      && (config['User'] === '1000:1000' || config['User'] === 'node-red'));
    for (const key of ['Devices', 'DeviceRequests', 'CapAdd', 'Mounts', 'VolumesFrom']) {
      demand(host[key] === undefined || host[key] === null || (Array.isArray(host[key]) && host[key].length === 0));
    }
    return { info, owner, id: info['Id'] };
  }

  private async assertCanStart(info: Record<string, unknown>, owner: Owner): Promise<void> {
    const host = object(info['HostConfig']);
    const network = await this.network(String(host['NetworkMode']));
    demand(sameOwner(owner, network.owner));
    demand(object(network.info['Labels'])[NETWORK_POLICY_REALM_LABEL] === deploymentRealm(this.config));
    assertContainerRuntimeIsolation(info, {
      containerName: owner.containerName, dataDirectory: owner.dataDirectory, network: network.id,
      networkName: owner.networkName, restartPolicy: owner.probe ? 'no' : 'unless-stopped', portRange: this.config.portRange,
    });
    const descriptor = await this.networks.ready(network.info, this.signal);
    const env = object(info['Config'])['Env']; demand(Array.isArray(env));
    for (const expected of this.guardEnvironment(descriptor.networkId, descriptor.gateway)) {
      const prefix = expected.slice(0, expected.indexOf('=') + 1);
      const found = env.filter(entry => typeof entry === 'string' && entry.startsWith(prefix));
      demand(found.length === 1 && found[0] === expected);
    }
    await this.approvedImage(info['Image']);
    await assertOwnedDirectory(this.config.dataRoot, owner.dataDirectory);
  }

  private async create(request: PolicyRequest, params: URLSearchParams): Promise<AuthorizedRequest> {
    query(params, ['name']);
    const input = jsonBody(request.body);
    const owner = ownerFromLabels(input['Labels'], this.config);
    demand(params.get('name') === owner.containerName && (input['name'] === undefined || input['name'] === owner.containerName));
    const host = object(input['HostConfig']);
    const network = await this.network(String(host['NetworkMode']));
    demand(sameOwner(owner, network.owner));
    demand(object(network.info['Labels'])[NETWORK_POLICY_REALM_LABEL] === deploymentRealm(this.config));
    const options = { ...input, name: owner.containerName, HostConfig: { ...host, NetworkMode: network.id } };
    assertContainerIsolation(options, {
      containerName: owner.containerName, dataDirectory: owner.dataDirectory, network: network.id,
      restartPolicy: owner.probe ? 'no' : 'unless-stopped', portRange: this.config.portRange,
    });
    demand(Array.isArray(input['Env']) && input['Env'].length <= 64
      && input['Env'].every(x => typeof x === 'string' && x.length <= 8192 && !x.includes('\0')));
    const allowedEnvironment = new Set([
      'TZ', 'TLE_INSTANCE_ID', 'TLE_ADMIN_ROOT', 'TLE_INGEST_TOKEN', 'TLE_MANAGER_URL', 'XDG_CONFIG_HOME',
      'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_STRICT_SSL', 'NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
      'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'ENV', 'BASH_ENV',
    ]);
    demand(input['Env'].every((entry: string) => allowedEnvironment.has(entry.slice(0, entry.indexOf('=')))));
    demand(new Set(input['Env'].map((entry: string) => entry.slice(0, entry.indexOf('=')))).size === input['Env'].length);
    const identities = input['Env'].filter((entry: string) => entry.startsWith('TLE_INSTANCE_ID='));
    demand(identities.length === 1 && identities[0] === `TLE_INSTANCE_ID=${owner.instanceId}`);
    const image = await this.approvedImage(input['Image']);
    await assertOwnedDirectory(this.config.dataRoot, owner.dataDirectory);
    await this.admitResources(host);
    const descriptor = await this.networks.ready(network.info, this.signal);
    const { name: _name, ...body } = options;
    const plan = writePlan('POST', `/containers/create?name=${owner.containerName}`, { ...body, Image: image,
      Env: [...input['Env'], ...this.guardEnvironment(descriptor.networkId, descriptor.gateway)] });
    plan.beforeForward = async () => {
      await assertOwnedDirectory(this.config.dataRoot, owner.dataDirectory);
      demand(sameOwner((await this.network(network.id)).owner, owner));
      await this.networks.ready(network.info, this.signal);
    };
    return plan;
  }

  private guardEnvironment(networkId: string, gateway: string): string[] {
    return [`TLE_NETWORK_GUARD_ID=${networkId}`, `TLE_NETWORK_GUARD_GATEWAY=${gateway}`, `TLE_NETWORK_GUARD_PORT=${this.config.networkHealthPort}`];
  }

  private async createNetwork(request: PolicyRequest): Promise<AuthorizedRequest> {
    const body = jsonBody(request.body);
    keys(body, ['Name', 'Driver', 'Internal', 'Labels', 'EnableIPv6']);
    const owner = ownerFromLabels(body['Labels'], this.config);
    demand(body['Name'] === owner.networkName && body['Driver'] === 'bridge' && (body['EnableIPv6'] === undefined || body['EnableIPv6'] === false)
      && (owner.probe ? body['Internal'] === true : body['Internal'] === undefined || body['Internal'] === false));
    const operation = await this.networks.prepareCreate({ ...body, EnableIPv6: false }, this.signal);
    return { ...writePlan('POST', '/networks/create', operation.body), beforeForward: operation.beforeDispatch,
      afterForward: operation.succeeded, onFailure: operation.failed };
  }

  private list(path: string, params: URLSearchParams, kind: 'containers' | 'networks'): AuthorizedRequest {
    query(params, kind === 'containers' ? ['all', 'filters', 'size', 'limit'] : ['filters']);
    const filters = object(params.has('filters') ? JSON.parse(params.get('filters')!) : {});
    keys(filters, ['label', 'name']);
    for (const values of Object.values(filters)) demand(Array.isArray(values) && values.length <= 20 && values.every(v => typeof v === 'string' && v.length <= 256));
    filters['label'] = [...new Set([...(filters['label'] as string[] ?? []), `${MANAGED}=true`])];
    params.set('filters', JSON.stringify(filters));
    if (kind === 'containers') {
      // Presence reconciliation treats a missing instance as stopped. Never silently truncate.
      params.set('size', 'false');
      demand(!params.has('all') || ['true', 'false', '0', '1'].includes(params.get('all')!));
      demand(!params.has('limit') || /^\d{1,4}$/.test(params.get('limit')!));
    }
    return {
      method: 'GET', path: pathWithQuery(path, params),
      transform: async (data: unknown) => {
        demand(Array.isArray(data) && data.length <= 4096);
        if (kind === 'containers') return this.ownedContainerSummaries(data);
        return data.filter(entry => {
          try {
            const item = object(entry), owner = ownerFromLabels(item['Labels'], this.config);
            const realm = object(item['Labels'])[NETWORK_POLICY_REALM_LABEL];
            return item['Name'] === owner.networkName && item['Driver'] === 'bridge'
              && (realm === undefined || realm === deploymentRealm(this.config));
          } catch { return false; }
        });
      },
    };
  }

  /** Summary mounts can use VM aliases on Docker Desktop; they are not ownership evidence. */
  private async ownedContainerSummaries(data: unknown[]): Promise<Record<string, unknown>[]> {
    const seen = new Set<string>();
    const candidates: Array<{ item: Record<string, unknown>; owner: Owner; id: string }> = [];
    for (const entry of data) {
      try {
        const item = object(entry), owner = ownerFromLabels(item['Labels'], this.config, true);
        const id = item['Id'];
        demand(typeof id === 'string' && ID.test(id)
          && Array.isArray(item['Names']) && item['Names'].includes(`/${owner.containerName}`));
        if (seen.has(id)) continue;
        seen.add(id); candidates.push({ item, owner, id });
      } catch { /* Foreign or malformed summaries never reach inspect. */ }
    }
    const result: Record<string, unknown>[] = [];
    // Bound independent daemon reads. Confirmed absence/ownership denial is local;
    // an unavailable inspection leaves the whole inventory unknown, never falsely empty.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      this.signal?.throwIfAborted();
      const inspected = await Promise.allSettled(candidates.slice(offset, offset + 4).map(async candidate => {
        try {
          const verified = await this.container(candidate.id);
          demand(verified.id === candidate.id && sameOwner(verified.owner, candidate.owner));
          return candidate.item;
        } catch (error) {
          if ((error as { statusCode?: number })?.statusCode === 404
            || (error instanceof PolicyDenied && error.statusCode === 403)) return undefined;
          // This transform runs after authorize() returned; transport/JSON errors
          // must not pass through authorize()'s mutation-oriented 403 fallback.
          throw new PolicyDenied(502);
        }
      }));
      if (inspected.some(item => item.status === 'rejected')) throw new PolicyDenied(502);
      for (const item of inspected) if (item.status === 'fulfilled' && item.value) result.push(item.value);
    }
    this.signal?.throwIfAborted();
    return result;
  }

  private async authorizeRequest(request: PolicyRequest): Promise<AuthorizedRequest> {
    const { pathname, params } = route(request.path);
    const method = request.method;
    demand(['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method));
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') demand(request.body.length === 0);
    if (pathname === '/_ping' && (method === 'GET' || method === 'HEAD')) {
      query(params, []); return { method, path: pathname };
    }
    if (method === 'GET' && ['/version', '/info'].includes(pathname)) {
      query(params, []); return { method, path: pathname };
    }
    if (method === 'GET' && pathname === '/containers/json') return this.list(pathname, params, 'containers');
    if (method === 'GET' && pathname === '/networks') return this.list(pathname, params, 'networks');
    if (method === 'POST' && pathname === '/containers/create') return this.create(request, params);
    if (method === 'POST' && pathname === '/networks/create') { query(params, []); return this.createNetwork(request); }
    if (method === 'GET' && pathname.startsWith('/images/') && pathname.endsWith('/json')) {
      query(params, []);
      const reference = decodeURIComponent(pathname.slice('/images/'.length, -'/json'.length));
      const id = await this.approvedImage(reference); return { method, path: `/images/${id}/json` };
    }
    const containerRoute = /^\/containers\/([^/]+)(?:\/(json|logs|stats|start|stop|restart|archive))?$/.exec(pathname);
    if (containerRoute) {
      const reference = resourceRef(containerRoute[1]!), action = containerRoute[2];
      if (method === 'GET' && action === 'json') {
        query(params, ['size']);
        const managerId = await this.manager(reference);
        if (managerId) return { method, path: `/containers/${managerId}/json` };
      }
      const container = await this.container(reference);
      const prefix = `/containers/${container.id}`;
      if (method === 'GET' && action === 'json') return { method, path: `${prefix}/json` };
      if (method === 'GET' && action === 'stats') {
        query(params, ['stream', 'one-shot']);
        demand(!params.has('stream') || ['false', '0'].includes(params.get('stream')!));
        return { method, path: `${prefix}/stats?stream=false` };
      }
      if (method === 'GET' && action === 'logs') {
        query(params, ['stdout', 'stderr', 'follow', 'timestamps', 'tail', 'since', 'until']);
        for (const name of ['stdout', 'stderr', 'follow', 'timestamps']) {
          demand(!params.has(name) || ['true', 'false', '0', '1'].includes(params.get(name)!));
        }
        const tail = Number(params.get('tail') ?? 200);
        demand(Number.isInteger(tail) && tail >= 0 && tail <= 2000); params.set('tail', String(tail));
        for (const name of ['since', 'until']) demand(!params.has(name) || /^[0-9TZ: .+-]{1,64}$/.test(params.get(name)!));
        return { method, path: pathWithQuery(`${prefix}/logs`, params) };
      }
      if (method === 'POST' && ['start', 'stop', 'restart'].includes(action ?? '')) {
        query(params, action === 'start' ? [] : ['t']);
        if (params.has('t')) demand(/^\d{1,2}$/.test(params.get('t')!) && Number(params.get('t')) <= 30);
        if (request.body.length > 0) {
          // docker-modem repeats stop/restart options in the body. Accept only the
          // exact same bounded timeout, then discard that redundant body.
          const body = jsonBody(request.body); keys(body, action === 'start' ? [] : ['t']);
          demand(Object.keys(body).length === 0 || (params.has('t') && body['t'] === Number(params.get('t'))));
        }
        if (action !== 'stop') await this.assertCanStart(container.info, container.owner);
        if (action !== 'stop') await this.admitResources(object(container.info['HostConfig']), container.id);
        return { method, path: pathWithQuery(`${prefix}/${action}`, params),
          ...(action !== 'stop' ? { beforeForward: async () => {
            const network = await this.network(String(object(container.info['HostConfig'])['NetworkMode']));
            demand(sameOwner(container.owner, network.owner));
            await this.networks.ready(network.info, this.signal);
          } } : {}),
        };
      }
      if (method === 'DELETE' && action === undefined) {
        query(params, ['force', 'v']);
        demand(!params.has('force') || ['true', 'false', '1', '0'].includes(params.get('force')!));
        demand(!params.has('v') || ['false', '0'].includes(params.get('v')!));
        params.delete('v'); return { method, path: pathWithQuery(prefix, params) };
      }
      if (method === 'PUT' && action === 'archive') {
        query(params, ['path']); demand(params.get('path') === '/data' && request.body.length <= 4 * 1024 ** 2);
        const files = untar(request.body);
        demand(files.length === 1 && files[0]!.name === 'settings.js');
        await assertOwnedDirectory(this.config.dataRoot, container.owner.dataDirectory);
        await assertSettingsTarget(container.owner.dataDirectory);
        return {
          method, path: `${prefix}/archive?path=%2Fdata&noOverwriteDirNonDir=true`,
          body: tarFile('settings.js', files[0]!.content, { uid: 1000, gid: 1000, mode: 0o644 }), contentType: 'application/x-tar',
          beforeForward: async () => {
            await assertOwnedDirectory(this.config.dataRoot, container.owner.dataDirectory);
            await assertSettingsTarget(container.owner.dataDirectory);
          },
        };
      }
      throw new PolicyDenied();
    }
    const networkRoute = /^\/networks\/([^/]+)(?:\/(connect|disconnect))?$/.exec(pathname);
    if (networkRoute) {
      query(params, []);
      const network = await this.network(resourceRef(networkRoute[1]!));
      const action = networkRoute[2], prefix = `/networks/${network.id}`;
      if (method === 'GET' && !action) return { method, path: prefix };
      if (method === 'DELETE' && !action) {
        demand(Object.keys(object(network.info['Containers'] ?? {})).length === 0);
        const operation = await this.networks.prepareDelete(network.info, this.signal);
        return { method, path: prefix, beforeForward: operation.beforeDispatch, afterForward: operation.succeeded, onFailure: operation.failed };
      }
      if (method === 'POST' && action) {
        const body = jsonBody(request.body);
        keys(body, action === 'connect' ? ['Container', 'EndpointConfig'] : ['Container', 'Force']);
        demand(typeof body['Container'] === 'string');
        const target = resourceRef(body['Container']);
        // Guests enter exactly one checked network during create. A later guest
        // connect would bypass both startup gating and unresolved-network intents.
        const id = await this.manager(target);
        demand(id);
        if (action === 'connect') {
          const endpoint = object(body['EndpointConfig']); keys(endpoint, ['Aliases', 'GwPriority']);
          demand(Array.isArray(endpoint['Aliases']) && endpoint['Aliases'].length === 1
            && endpoint['Aliases'][0] === this.config.managerContainer && endpoint['GwPriority'] === -1);
        }
        demand(body['Force'] === undefined || typeof body['Force'] === 'boolean');
        return writePlan(method, `${prefix}/${action}`, { ...body, Container: id });
      }
    }
    throw new PolicyDenied();
  }
}
