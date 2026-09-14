import { lstat, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  assertValidId, BOOTSTRAP_TX_LABEL, MIGRATION_TX_LABEL, MIGRATION_PROBE_LABEL,
  containerName, migrationProbeName, migrationProbeNetworkName, migrationProbeDataDir,
} from '../instance/container-spec.ts';
import { demand, keys, object, type PolicyConfig } from './config.ts';

export const MANAGED = 'com.mqttsnet.thinglinks-edge.managed';
export const INSTANCE = 'com.mqttsnet.thinglinks-edge.instance';
const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface Owner {
  instanceId: string;
  containerName: string;
  networkName: string;
  dataDirectory: string;
  probe: boolean;
  txId?: string;
  bootstrapTxId?: string;
}

export function ownerFromLabels(raw: unknown, config: PolicyConfig, inheritedImageLabels = false): Owner {
  const input = object(raw);
  const ownerKeys = [MANAGED, INSTANCE, BOOTSTRAP_TX_LABEL, MIGRATION_TX_LABEL, MIGRATION_PROBE_LABEL];
  const labels = inheritedImageLabels
    ? Object.fromEntries(Object.entries(input).filter(([key]) => ownerKeys.includes(key)))
    : input;
  keys(labels, ownerKeys);
  demand(labels[MANAGED] === 'true' && typeof labels[INSTANCE] === 'string');
  const instanceId = labels[INSTANCE];
  assertValidId(instanceId);
  const bootstrap = labels[BOOTSTRAP_TX_LABEL];
  if (bootstrap !== undefined) demand(typeof bootstrap === 'string' && TX.test(bootstrap));
  const tx = labels[MIGRATION_TX_LABEL];
  const probe = labels[MIGRATION_PROBE_LABEL] === 'true';
  if (probe) demand(typeof tx === 'string' && TX.test(tx) && bootstrap === undefined);
  else demand(tx === undefined && labels[MIGRATION_PROBE_LABEL] === undefined);
  return {
    instanceId, probe,
    containerName: probe ? migrationProbeName(instanceId, String(tx)) : containerName(instanceId),
    networkName: probe ? migrationProbeNetworkName(instanceId, String(tx)) : `${config.networkPrefix}-${instanceId}`,
    dataDirectory: probe ? migrationProbeDataDir(config.dataRoot, instanceId, String(tx)) : join(config.dataRoot, instanceId),
    ...(probe ? { txId: String(tx) } : {}),
    ...(typeof bootstrap === 'string' ? { bootstrapTxId: bootstrap } : {}),
  };
}

export function sameOwner(left: Owner, right: Owner): boolean {
  return left.instanceId === right.instanceId && left.probe === right.probe
    && left.txId === right.txId && left.bootstrapTxId === right.bootstrapTxId;
}

/** Check every segment below the operator-configured root; never follow an instance-owned symlink. */
export async function assertOwnedDirectory(root: string, directory: string): Promise<void> {
  const rel = relative(root, directory);
  demand(rel.length > 0 && !rel.startsWith('..') && resolve(root, rel) === directory);
  const rootStat = await lstat(root);
  demand(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const realRoot = await realpath(root);
  let current = root;
  for (const segment of rel.split('/')) {
    current = join(current, segment);
    const entry = await lstat(current);
    demand(entry.isDirectory() && !entry.isSymbolicLink());
  }
  demand(await realpath(directory) === join(realRoot, rel));
}

export async function assertSettingsTarget(directory: string): Promise<void> {
  try {
    const info = await lstat(join(directory, 'settings.js'));
    demand(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
