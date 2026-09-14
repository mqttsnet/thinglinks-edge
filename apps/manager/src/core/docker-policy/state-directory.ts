import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demand, deploymentRealm, type PolicyConfig } from './config.ts';

const MARKER = '.thinglinks-docker-policy-owner';

/** An empty dedicated volume can be adopted; an unknown shared directory never can. */
export function initializePolicyStateDirectory(config: Pick<PolicyConfig, 'stateRoot' | 'dataRoot' | 'networkPrefix'>): void {
  const root = config.stateRoot, stat = lstatSync(root);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(root) === root && stat.uid === process.getuid?.());
  const contents = readdirSync(root);
  const expected = JSON.stringify({ version: 1, component: 'thinglinks-docker-policy',
    owner: deploymentRealm(config) });
  const path = join(root, MARKER);
  if (!contents.includes(MARKER)) {
    demand(contents.length === 0);
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, expected); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return;
  }
  demand(contents.every(name => name === MARKER || name === 'network-intents'));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const marker = fstatSync(descriptor);
    demand(marker.isFile() && marker.nlink === 1 && marker.uid === stat.uid && (marker.mode & 0o777) === 0o600 && marker.size <= 512);
    const buffer = Buffer.alloc(513), bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    demand(buffer.toString('utf8', 0, bytes) === expected);
  } finally { closeSync(descriptor); }
}
