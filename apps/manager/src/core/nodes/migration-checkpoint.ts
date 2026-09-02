import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NodeMigrationState } from '../instance/repo.ts';
import { assertValidId } from '../instance/container-spec.ts';

const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const CHECKPOINT_FILE_PATHS = Object.freeze([
  'settings.js',
  'settings.js.backup',
  'flows.json',
  'flows.json.backup',
  'flows_cred.json',
  'flows_cred.json.backup',
  'package.json',
  'package.json.backup',
  'package-lock.json',
  'package-lock.json.backup',
  '.config.nodes.json',
  '.config.nodes.json.backup',
  '.config.modules.json',
  '.config.modules.json.backup',
] as const);

export type MigrationCheckpointFilePath = typeof CHECKPOINT_FILE_PATHS[number];

/** Cleanup/uninstall runs first; restore module bookkeeping, then package state, secrets last. */
const RESTORE_FILE_PATHS: readonly MigrationCheckpointFilePath[] = [
  '.config.nodes.json',
  '.config.nodes.json.backup',
  '.config.modules.json',
  '.config.modules.json.backup',
  'package.json',
  'package.json.backup',
  'package-lock.json',
  'package-lock.json.backup',
  'settings.js',
  'settings.js.backup',
  'flows.json',
  'flows.json.backup',
  'flows_cred.json',
  'flows_cred.json.backup',
];

export type MigrationCheckpointFile =
  | { path: MigrationCheckpointFilePath; exists: false }
  | {
      path: MigrationCheckpointFilePath;
      exists: true;
      mode: number;
      size: number;
      sha256: string;
    };

export interface MigrationCheckpointManifest {
  version: 1;
  instanceId: string;
  txId: string;
  files: MigrationCheckpointFile[];
}

export class MigrationCheckpointError extends Error {
  constructor(message: string) {
    super(message.slice(0, 300));
    this.name = 'MigrationCheckpointError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface StableFile {
  bytes: Buffer;
  mode: number;
  size: number;
  sha256: string;
}

function sameFileIdentity(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Read through a no-follow descriptor and reject a source changed during capture. */
async function readStableRegularFile(path: string, label: string): Promise<StableFile | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MigrationCheckpointError(`${label} is untrusted or could not be opened safely`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new MigrationCheckpointError(`${label} must be a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new MigrationCheckpointError(`${label} changed during checkpoint capture`);
    }
    return {
      bytes,
      mode: before.mode & 0o777,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  } catch (error) {
    if (error instanceof MigrationCheckpointError) throw error;
    throw new MigrationCheckpointError(`${label} could not be read safely`);
  } finally {
    await handle.close();
  }
}

function exactManifest(value: unknown, instanceId: string, txId: string): MigrationCheckpointManifest {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new MigrationCheckpointError('checkpoint manifest must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join('\0');
  if (keys !== ['files', 'instanceId', 'txId', 'version'].sort().join('\0')) {
    throw new MigrationCheckpointError('checkpoint manifest has unauthorized fields');
  }
  if (record['version'] !== 1 || record['instanceId'] !== instanceId || record['txId'] !== txId) {
    throw new MigrationCheckpointError('checkpoint manifest identity mismatch');
  }
  if (!Array.isArray(record['files']) || record['files'].length !== CHECKPOINT_FILE_PATHS.length) {
    throw new MigrationCheckpointError('checkpoint manifest file set mismatch');
  }
  const files = record['files'].map((raw, index): MigrationCheckpointFile => {
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') {
      throw new MigrationCheckpointError('checkpoint manifest file fact is invalid');
    }
    const fact = raw as Record<string, unknown>;
    const path = CHECKPOINT_FILE_PATHS[index]!;
    if (fact['path'] !== path) {
      throw new MigrationCheckpointError('checkpoint manifest file order mismatch');
    }
    if (fact['exists'] === false) {
      if (Object.keys(fact).sort().join('\0') !== ['exists', 'path'].sort().join('\0')) {
        throw new MigrationCheckpointError(`${path} missing fact has unauthorized fields`);
      }
      return { path, exists: false };
    }
    if (
      fact['exists'] !== true
      || Object.keys(fact).sort().join('\0')
        !== ['exists', 'mode', 'path', 'sha256', 'size'].sort().join('\0')
      || !Number.isInteger(fact['mode'])
      || (fact['mode'] as number) < 0
      || (fact['mode'] as number) > 0o777
      || !Number.isInteger(fact['size'])
      || (fact['size'] as number) < 0
      || typeof fact['sha256'] !== 'string'
      || !SHA256.test(fact['sha256'])
    ) {
      throw new MigrationCheckpointError(`${path} checkpoint fact is invalid`);
    }
    return {
      path,
      exists: true,
      mode: fact['mode'] as number,
      size: fact['size'] as number,
      sha256: fact['sha256'],
    };
  });
  return { version: 1, instanceId, txId, files };
}

export class MigrationCheckpointStore {
  private readonly instanceDataRoot: string;

  constructor(instanceDataRoot: string) {
    if (!isAbsolute(instanceDataRoot)) {
      throw new MigrationCheckpointError('Manager instance data root must be absolute');
    }
    this.instanceDataRoot = resolve(instanceDataRoot);
  }

  private paths(instanceId: string, txId: string): {
    live: string;
    migrationRoot: string;
    instanceRoot: string;
    ready: string;
    partial: string;
  } {
    try {
      assertValidId(instanceId);
    } catch {
      throw new MigrationCheckpointError('checkpoint instance id is invalid');
    }
    if (!TX_ID.test(txId)) throw new MigrationCheckpointError('checkpoint tx id is invalid');
    const migrationRoot = resolve(this.instanceDataRoot, '.thinglinks-migration');
    const instanceRoot = resolve(migrationRoot, instanceId);
    const ready = resolve(instanceRoot, txId);
    const partial = resolve(instanceRoot, `${txId}.partial`);
    const live = resolve(this.instanceDataRoot, instanceId);
    if (
      !contained(this.instanceDataRoot, migrationRoot)
      || !contained(migrationRoot, instanceRoot)
      || !contained(instanceRoot, ready)
      || !contained(instanceRoot, partial)
      || !contained(this.instanceDataRoot, live)
      || contained(live, ready)
    ) {
      throw new MigrationCheckpointError('checkpoint path escapes Manager root');
    }
    return { live, migrationRoot, instanceRoot, ready, partial };
  }

  private async prepareParents(paths: ReturnType<MigrationCheckpointStore['paths']>): Promise<void> {
    await this.requireTrustedDirectory(this.instanceDataRoot, 'Manager instance data root');
    await this.requireTrustedDirectory(paths.live, 'live instance root');
    if (!await this.requireTrustedDirectory(paths.migrationRoot, 'migration root', true)) {
      await mkdir(paths.migrationRoot, { mode: 0o700 });
      await syncPath(this.instanceDataRoot);
    }
    await chmod(paths.migrationRoot, 0o700);
    if (!await this.requireTrustedDirectory(paths.instanceRoot, 'checkpoint instance root', true)) {
      await mkdir(paths.instanceRoot, { mode: 0o700 });
      await syncPath(paths.migrationRoot);
    }
    await chmod(paths.instanceRoot, 0o700);
  }

  private async requireTrustedDirectory(
    path: string,
    label: string,
    allowMissing = false,
  ): Promise<boolean> {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new MigrationCheckpointError(`${label} is missing`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MigrationCheckpointError(`${label} is not a trusted directory`);
    }
    return true;
  }

  private async trustedReadyParents(
    paths: ReturnType<MigrationCheckpointStore['paths']>,
  ): Promise<boolean> {
    await this.requireTrustedDirectory(this.instanceDataRoot, 'Manager instance data root');
    await this.requireTrustedDirectory(paths.live, 'live instance root');
    if (!await this.requireTrustedDirectory(paths.migrationRoot, 'migration root', true)) return false;
    if (!await this.requireTrustedDirectory(paths.instanceRoot, 'checkpoint instance root', true)) return false;
    return true;
  }

  async create(instanceId: string, txId: string): Promise<string> {
    const paths = this.paths(instanceId, txId);
    await this.prepareParents(paths);
    if (await this.readyExists(instanceId, txId)) {
      await this.verify(instanceId, txId);
      return paths.ready;
    }
    await this.cleanupPartial(instanceId, txId);
    await mkdir(paths.partial, { mode: 0o700 });
    await chmod(paths.partial, 0o700);
    const filesRoot = join(paths.partial, 'files');
    await mkdir(filesRoot, { mode: 0o700 });
    await chmod(filesRoot, 0o700);

    const files: MigrationCheckpointFile[] = [];
    for (const path of CHECKPOINT_FILE_PATHS) {
      const source = join(paths.live, path);
      const sourceFile = await readStableRegularFile(source, path);
      if (!sourceFile) {
        files.push({ path, exists: false });
        continue;
      }
      const destination = join(filesRoot, path);
      const handle = await open(destination, 'wx', sourceFile.mode);
      try {
        await handle.writeFile(sourceFile.bytes);
        await chmod(destination, sourceFile.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      files.push({
        path,
        exists: true,
        mode: sourceFile.mode,
        size: sourceFile.size,
        sha256: sourceFile.sha256,
      });
    }

    const checkpointManifest: MigrationCheckpointManifest = {
      version: 1,
      instanceId,
      txId,
      files,
    };
    const manifestPath = join(paths.partial, 'manifest.json');
    const manifestHandle = await open(manifestPath, 'wx', 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(checkpointManifest)}\n`, 'utf8');
      await chmod(manifestPath, 0o600);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    await syncPath(filesRoot);
    await syncPath(paths.partial);
    await rename(paths.partial, paths.ready);
    await syncPath(paths.instanceRoot);
    return paths.ready;
  }

  async cleanupPartial(instanceId: string, txId: string): Promise<void> {
    const paths = this.paths(instanceId, txId);
    if (!await this.trustedReadyParents(paths)) return;
    const { partial } = paths;
    let stat;
    try {
      stat = await lstat(partial);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MigrationCheckpointError('partial checkpoint could not be inspected');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MigrationCheckpointError('partial checkpoint is not a trusted directory');
    }
    await rm(partial, { recursive: true, force: false });
  }

  async readyExists(instanceId: string, txId: string): Promise<boolean> {
    const paths = this.paths(instanceId, txId);
    if (!await this.trustedReadyParents(paths)) return false;
    const { ready } = paths;
    try {
      const stat = await lstat(ready);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new MigrationCheckpointError('ready checkpoint is not a trusted directory');
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async readManifest(instanceId: string, txId: string): Promise<MigrationCheckpointManifest> {
    const { ready } = this.paths(instanceId, txId);
    const manifestPath = join(ready, 'manifest.json');
    const manifest = await readStableRegularFile(manifestPath, 'checkpoint manifest');
    if (!manifest) throw new MigrationCheckpointError('checkpoint manifest is missing');
    if (manifest.mode !== 0o600) throw new MigrationCheckpointError('checkpoint manifest permissions are untrusted');
    const raw = manifest.bytes.toString('utf8');
    try {
      return exactManifest(JSON.parse(raw), instanceId, txId);
    } catch (error) {
      if (error instanceof MigrationCheckpointError) throw error;
      throw new MigrationCheckpointError('checkpoint manifest is invalid JSON');
    }
  }

  async verify(instanceId: string, txId: string): Promise<MigrationCheckpointManifest> {
    const paths = this.paths(instanceId, txId);
    if (!await this.readyExists(instanceId, txId)) {
      throw new MigrationCheckpointError('ready checkpoint is missing');
    }
    let readyStat;
    try {
      readyStat = await lstat(paths.ready);
    } catch {
      throw new MigrationCheckpointError('ready checkpoint is missing');
    }
    if (!readyStat.isDirectory() || readyStat.isSymbolicLink() || (readyStat.mode & 0o777) !== 0o700) {
      throw new MigrationCheckpointError('ready checkpoint permissions are untrusted');
    }
    const filesRoot = join(paths.ready, 'files');
    const filesRootStat = await lstat(filesRoot).catch(() => undefined);
    if (
      !filesRootStat
      || !filesRootStat.isDirectory()
      || filesRootStat.isSymbolicLink()
      || (filesRootStat.mode & 0o777) !== 0o700
    ) throw new MigrationCheckpointError('checkpoint files root is not trusted');
    const checkpointManifest = await this.readManifest(instanceId, txId);
    for (const fact of checkpointManifest.files) {
      const checkpointFile = join(paths.ready, 'files', fact.path);
      if (!fact.exists) {
        if (await exists(checkpointFile)) {
          throw new MigrationCheckpointError(`${fact.path} unexpected checkpoint file`);
        }
        continue;
      }
      const file = await readStableRegularFile(checkpointFile, `${fact.path} checkpoint file`);
      if (!file) throw new MigrationCheckpointError(`${fact.path} checkpoint file is missing`);
      if (file.size !== fact.size || file.sha256 !== fact.sha256) {
        throw new MigrationCheckpointError(`${fact.path} checkpoint hash mismatch`);
      }
      if (file.mode !== fact.mode) {
        throw new MigrationCheckpointError(`${fact.path} checkpoint mode mismatch`);
      }
    }
    return checkpointManifest;
  }

  async restore(instanceId: string, txId: string): Promise<void> {
    const paths = this.paths(instanceId, txId);
    const checkpointManifest = await this.verify(instanceId, txId);
    const facts = new Map(checkpointManifest.files.map((fact) => [fact.path, fact]));
    for (const path of RESTORE_FILE_PATHS) {
      const fact = facts.get(path);
      if (!fact) throw new MigrationCheckpointError(`${path} restore fact is missing`);
      const destination = join(paths.live, fact.path);
      let destinationStat;
      try {
        destinationStat = await lstat(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new MigrationCheckpointError(`${fact.path} live file could not be inspected`);
        }
      }
      if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink())) {
        throw new MigrationCheckpointError(`${fact.path} live path is untrusted`);
      }
      if (!fact.exists) {
        if (destinationStat) await unlink(destination);
        continue;
      }
      const source = await readStableRegularFile(
        join(paths.ready, 'files', fact.path),
        `${fact.path} checkpoint restore file`,
      );
      if (!source) throw new MigrationCheckpointError(`${fact.path} checkpoint restore file is missing`);
      if (source.size !== fact.size || source.sha256 !== fact.sha256 || source.mode !== fact.mode) {
        throw new MigrationCheckpointError(`${fact.path} checkpoint restore fact mismatch`);
      }
      const partial = `${destination}.thinglinks-restore-${txId}.partial`;
      await rm(partial, { force: true });
      const handle = await open(partial, 'wx', fact.mode);
      try {
        await handle.writeFile(source.bytes);
        await chmod(partial, fact.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(partial, destination);
    }
    await syncPath(paths.live);
    await this.verifyLive(instanceId, txId);
  }

  async verifyLive(instanceId: string, txId: string): Promise<void> {
    const { live } = this.paths(instanceId, txId);
    const checkpointManifest = await this.verify(instanceId, txId);
    for (const fact of checkpointManifest.files) {
      const path = join(live, fact.path);
      if (!fact.exists) {
        if (await exists(path)) throw new MigrationCheckpointError(`${fact.path} live existence mismatch`);
        continue;
      }
      const file = await readStableRegularFile(path, `${fact.path} live file`);
      if (!file) throw new MigrationCheckpointError(`${fact.path} live file is missing`);
      if (file.size !== fact.size || file.sha256 !== fact.sha256) {
        throw new MigrationCheckpointError(`${fact.path} live hash mismatch`);
      }
      if (file.mode !== fact.mode) {
        throw new MigrationCheckpointError(`${fact.path} live mode mismatch`);
      }
    }
  }

  async cleanupTerminal(
    instanceId: string,
    txId: string,
    phase: NodeMigrationState,
  ): Promise<boolean> {
    if (phase !== 'committed' && phase !== 'rolled_back') return false;
    const { ready, instanceRoot } = this.paths(instanceId, txId);
    if (!await this.readyExists(instanceId, txId)) return true;
    await this.verify(instanceId, txId);
    await rm(ready, { recursive: true, force: false });
    await syncPath(instanceRoot);
    if (await this.readyExists(instanceId, txId)) {
      throw new MigrationCheckpointError('checkpoint cleanup did not remove ready directory');
    }
    return true;
  }
}
