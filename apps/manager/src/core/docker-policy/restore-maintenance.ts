import { dirname } from 'node:path';
import { demand, object, PolicyDenied, type PolicyConfig } from './config.ts';
import type { DaemonReader } from './policy.ts';

export const RESTORE_WRITERS_PATH = '/maintenance/restore-writers';
const ID = /^[a-f0-9]{64}$/;
const COMPOSE = 'com.docker.compose.';
const normalizeIp = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
const sourcePath = (path: string) => path.replace(/^\/host_mnt(?=\/)|^\/run\/desktop\/mnt\/host(?=\/)/, '');
const below = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

function bindMounts(info: Record<string, unknown>): Record<string, unknown>[] {
  demand(Array.isArray(info['Mounts']));
  return info['Mounts'].map(object).filter(mount => mount['Type'] === 'bind');
}
function hasDataBind(info: Record<string, unknown>, root: string): boolean {
  return bindMounts(info).some(mount => typeof mount['Source'] === 'string'
    && sourcePath(mount['Source']) === root && mount['Destination'] === root && mount['RW'] === true);
}
function restoreCommand(value: Record<string, unknown>): boolean {
  const entry = value['Entrypoint'], command = value['Cmd'];
  if (!Array.isArray(entry) || entry.length !== 1 || !['node', '/usr/local/bin/node'].includes(entry[0])
    || !Array.isArray(command) || !command.every(item => typeof item === 'string')
    || !['dist/index.js', '/app/dist/index.js'].includes(String(command[0])) || command[1] !== 'restore'
    || value['WorkingDir'] !== '/app') return false;
  const rest: string[] = command.slice(2);
  if (rest.length === 1 && rest[0] === '--recover') return true;
  return (rest.length === 1 || (rest.length === 2 && rest.includes('--force')))
    && rest.filter(item => !item.startsWith('--') && item.length > 0).length === 1
    && rest.every(item => !item.startsWith('--') || item === '--force');
}

/** Derive peer authority from daemon facts, never client headers or Manager-written labels. */
export async function authorizeRestorePeer(
  config: PolicyConfig, daemon: DaemonReader, manager: Record<string, unknown>, peer: string,
): Promise<string> {
  demand(manager['Name'] === `/${config.managerContainer}`);
  const expected = object(manager['Config']), labels = object(expected['Labels']);
  demand(typeof labels[`${COMPOSE}project`] === 'string' && labels[`${COMPOSE}project`]
    && labels[`${COMPOSE}service`] === 'manager' && typeof manager['Image'] === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(manager['Image']) && hasDataBind(manager, dirname(config.dataRoot)));
  const managerNetworks = object(object(manager['NetworkSettings'])['Networks']);
  const sharedNetworks = new Set<string>();
  for (const [name, value] of Object.entries(managerNetworks)) {
    const id = object(value)['NetworkID'];
    if (typeof id === 'string' && ID.test(id)) sharedNetworks.add(id);
    else {
      // Docker clears endpoint IDs on a stopped container. Resolve only its saved
      // Compose network name, then verify the immutable network and project label.
      demand(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name));
      const network = object(await daemon.json(`/networks/${name}`));
      demand(network['Name'] === name && typeof network['Id'] === 'string' && ID.test(network['Id'])
        && object(network['Labels'])[`${COMPOSE}project`] === labels[`${COMPOSE}project`]);
      sharedNetworks.add(network['Id']);
    }
  }
  const filters = encodeURIComponent(JSON.stringify({ label: [
    `${COMPOSE}project=${labels[`${COMPOSE}project`]}`, `${COMPOSE}service=manager`,
  ] }));
  const candidates = await daemon.json(`/containers/json?all=true&filters=${filters}`);
  demand(Array.isArray(candidates) && candidates.length <= 256);
  const matches: string[] = [];
  for (const candidate of candidates) {
    const id = object(candidate)['Id'];
    demand(typeof id === 'string' && ID.test(id));
    if (id === manager['Id']) continue;
    const info = object(await daemon.json(`/containers/${id}/json`));
    if (info['Id'] !== id) throw new PolicyDenied();
    const value = object(info['Config']), candidateLabels = object(value['Labels']);
    if (String(candidateLabels[`${COMPOSE}oneoff`]).toLowerCase() !== 'true') continue;
    if (['project', 'service', 'project.config_files', 'project.working_dir'].some(key =>
      typeof labels[`${COMPOSE}${key}`] !== 'string' || !labels[`${COMPOSE}${key}`]
      || candidateLabels[`${COMPOSE}${key}`] !== labels[`${COMPOSE}${key}`])) continue;
    if (info['Image'] !== manager['Image'] || value['User'] !== expected['User']
      || !['node', '1000', '1000:1000'].includes(String(value['User'])) || !restoreCommand(value)) continue;
    const state = object(info['State']), host = object(info['HostConfig']);
    if (state['Running'] !== true || state['Paused'] === true || state['Restarting'] === true
      || host['Privileged'] === true || ['host', 'container'].some(prefix => String(host['NetworkMode']).startsWith(prefix))
      || host['PidMode'] === 'host' || (Array.isArray(host['CapAdd']) && host['CapAdd'].length)) continue;
    const root = dirname(config.dataRoot);
    if (!hasDataBind(info, root) || bindMounts(info).some(mount =>
      mount['RW'] === true && (typeof mount['Source'] !== 'string' || sourcePath(mount['Source']) !== root)
      || String(mount['Source']).endsWith('/docker.sock'))) continue;
    const environment = value['Env'];
    if (!Array.isArray(environment)) continue;
    const rootValues = environment.filter(item => typeof item === 'string' && item.startsWith('EDGE_DATA_ROOT='));
    if (rootValues.length !== 1 || rootValues[0] !== `EDGE_DATA_ROOT=${root}`) continue;
    const networks = object(object(info['NetworkSettings'])['Networks']);
    if (Object.values(networks).some(raw => {
      const network = object(raw);
      return typeof network['NetworkID'] === 'string' && network['NetworkID'] !== '' && sharedNetworks.has(network['NetworkID'])
        && [network['IPAddress'], network['GlobalIPv6Address']].some(ip =>
          typeof ip === 'string' && ip !== '' && normalizeIp(ip) === normalizeIp(peer));
    })) matches.push(id);
  }
  demand(matches.length === 1);
  return matches[0]!;
}

export interface RestoreWriterSnapshot {
  version: 1;
  instanceDataRoot: string;
  writers: Array<{ id: string; name: string; state: string; stopped: boolean }>;
}

/** All writable binds covering the deployment count, even unsafe or renamed containers. */
export async function restoreWriterSnapshot(
  config: PolicyConfig, daemon: DaemonReader, maintenanceId?: string,
): Promise<RestoreWriterSnapshot> {
  const listed = await daemon.json('/containers/json?all=true');
  demand(Array.isArray(listed) && listed.length <= 4096);
  const writers: RestoreWriterSnapshot['writers'] = [];
  for (const item of listed) {
    const id = object(item)['Id'];
    demand(typeof id === 'string' && ID.test(id));
    if (id === maintenanceId) continue;
    const info = object(await daemon.json(`/containers/${id}/json`));
    demand(info['Id'] === id);
    const root = dirname(config.dataRoot);
    const touchesRoot = bindMounts(info).some(mount => mount['RW'] === true && typeof mount['Source'] === 'string'
      && (below(sourcePath(mount['Source']), root) || below(root, sourcePath(mount['Source']))));
    if (!touchesRoot && info['Name'] !== `/${config.managerContainer}`) continue;
    const state = object(info['State']);
    const stopped = ['exited', 'created'].includes(String(state['Status'])) && state['Running'] === false
      && state['Paused'] !== true && state['Restarting'] !== true && state['Dead'] !== true;
    writers.push({ id, name: typeof info['Name'] === 'string' ? info['Name'] : id,
      state: typeof state['Status'] === 'string' ? state['Status'] : 'unknown', stopped });
  }
  return { version: 1, instanceDataRoot: config.dataRoot, writers };
}
