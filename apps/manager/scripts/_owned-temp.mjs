import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, sep } from 'node:path';

const SAFE_ROLE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
const SAFE_TOKEN = /^[a-f0-9]{12}$/;

export function resolveCanonicalTempParent(adapters = {}) {
  const pathExists = adapters.existsSync ?? existsSync;
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const candidate = pathExists('/private/tmp') ? '/private/tmp' : '/tmp';
  const parent = canonicalize(candidate);
  if (parent !== '/private/tmp' && parent !== '/tmp') {
    throw new Error(`canonical temp parent escapes allowed boundary: ${parent}`);
  }
  return parent;
}

export function assertOwnedTempArea(area, adapters = {}) {
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const inspect = adapters.lstatSync ?? lstatSync;
  const read = adapters.readFileSync ?? readFileSync;
  if (canonicalize(area.root) !== area.root) {
    throw new Error(`owned temp root changed path: ${area.root}`);
  }
  if (!area.root.startsWith(`${area.parent}${sep}${area.prefix}`)) {
    throw new Error(`owned temp root escaped prefix: ${area.root}`);
  }
  const rel = relative(area.parent, area.root);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`owned temp root escaped canonical parent: ${area.root}`);
  }
  const rootStat = inspect(area.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`owned temp root changed type: ${area.root}`);
  }
  const markerStat = inspect(area.marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error(`owned temp marker changed type: ${area.marker}`);
  }
  if (read(area.marker, 'utf8') !== area.ownerText) {
    throw new Error(`owned temp marker changed owner: ${area.marker}`);
  }
  return true;
}

/**
 * The marker lives beside `dataDir`, not inside it. Restore/extraction code may
 * replace everything below dataDir, but can never erase the cleanup authority.
 */
export function createOwnedTempArea(role, {
  outerRunId = process.env.TLE_VERIFY_RUN_ID?.trim() || '',
  randomToken = randomBytes(6).toString('hex'),
  adapters = {},
} = {}) {
  if (!SAFE_ROLE.test(role)) throw new Error(`invalid verifier temp role: ${role}`);
  if (!SAFE_TOKEN.test(randomToken)) throw new Error('invalid verifier temp random token');
  const runId = outerRunId || `local-${randomToken}`;
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid verifier run id: ${runId}`);

  const parent = resolveCanonicalTempParent(adapters);
  const prefix = `tle-${role}-${randomToken}.`;
  const make = adapters.mkdtempSync ?? mkdtempSync;
  const canonicalize = adapters.realpathSync ?? realpathSync;
  const makeDir = adapters.mkdirSync ?? mkdirSync;
  const write = adapters.writeFileSync ?? writeFileSync;
  const root = canonicalize(make(join(parent, prefix)));
  const marker = join(root, '.tle-verifier-owner');
  const dataDir = join(root, 'data');
  const ownerText = `${runId}\n${randomToken}\n`;
  const area = Object.freeze({ root, dataDir, marker, parent, prefix, ownerText });
  let markerCreated = false;
  try {
    write(marker, ownerText, { flag: 'wx', mode: 0o600 });
    markerCreated = true;
    makeDir(dataDir, { mode: 0o700 });
    assertOwnedTempArea(area, adapters);
    return area;
  } catch (error) {
    if (!markerCreated) throw error;
    try {
      removeOwnedTempArea(area, adapters);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `owned temp initialization and cleanup failed: ${root}`,
      );
    }
    throw error;
  }
}

export function removeOwnedTempArea(area, adapters = {}) {
  assertOwnedTempArea(area, adapters);
  const remove = adapters.rmSync ?? rmSync;
  const pathExists = adapters.existsSync ?? existsSync;
  remove(area.root, { recursive: true, force: false });
  if (pathExists(area.root)) throw new Error(`owned temp root still exists: ${area.root}`);
}

export function cleanupOwnedTempAreas(areas, adapters = {}) {
  const failures = [];
  for (const area of [...areas].reverse()) {
    try {
      removeOwnedTempArea(area, adapters);
      const at = areas.indexOf(area);
      if (at >= 0) areas.splice(at, 1);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'verifier temp cleanup failed');
}

export async function allocateLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('unable to allocate verifier loopback port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

export async function closeVerifierResources(resources) {
  const failures = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      failures.push(new Error(`${resource.label}: ${error.message}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'verifier resource cleanup failed');
}

export function databaseCloser(db) {
  return {
    label: 'db',
    close() {
      if (db?.open !== false) db?.close();
    },
  };
}
