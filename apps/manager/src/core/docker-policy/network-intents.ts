import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const NETWORK_POLICY_OP_LABEL = 'com.mqttsnet.thinglinks-edge.network-policy-op';
export const NETWORK_POLICY_REALM_LABEL = 'com.mqttsnet.thinglinks-edge.network-policy-realm';
const MANAGED = 'com.mqttsnet.thinglinks-edge.managed';
const INSTANCE = 'com.mqttsnet.thinglinks-edge.instance';
const BOOTSTRAP = 'com.mqttsnet.thinglinks-edge.bootstrap-tx';
const MIGRATION = 'com.mqttsnet.thinglinks-edge.migration-tx';
const PROBE = 'com.mqttsnet.thinglinks-edge.migration-probe';
const LABEL_KEYS = new Set([MANAGED, INSTANCE, BOOTSTRAP, MIGRATION, PROBE, NETWORK_POLICY_OP_LABEL, NETWORK_POLICY_REALM_LABEL]);
const OP = /^[a-f0-9]{32}$/;
const NETWORK_ID = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INSTANCE_ID = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const TEMP_FILE = /^\.[a-f0-9]{32}\.[a-f0-9]{32}\.tmp$/;

export interface NetworkIntent {
  opId: string;
  kind: 'create' | 'delete';
  name: string;
  labels: Record<string, string>;
  networkId?: string;
}

export type NetworkIntentWriteStep = 'before-file-sync' | 'before-publish' | 'after-publish' | 'after-directory-sync';
export interface NetworkIntentStoreOptions {
  maxEntries?: number;
  maxFileBytes?: number;
  /** Fault-injection seam for local tests; never populated from a policy HTTP request. */
  onWriteStep?(step: NetworkIntentWriteStep): void;
}

export class NetworkIntentError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkIntentError'; }
}

function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new NetworkIntentError(message);
}

function object(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Invalid network intent object');
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): void {
  demand(Object.keys(value).every(key => keys.has(key)), 'Unknown network intent field');
}

function validate(input: unknown): NetworkIntent {
  const value = object(input);
  onlyKeys(value, new Set(['opId', 'kind', 'name', 'labels', 'networkId']));
  demand(typeof value.opId === 'string' && OP.test(value.opId), 'Invalid network intent operation ID');
  demand(value.kind === 'create' || value.kind === 'delete', 'Invalid network intent kind');
  demand(typeof value.name === 'string' && NAME.test(value.name), 'Invalid network intent name');
  const rawLabels = object(value.labels);
  onlyKeys(rawLabels, LABEL_KEYS);
  demand(Object.values(rawLabels).every(label => typeof label === 'string' && label.length <= 128), 'Invalid network intent labels');
  const labels = Object.fromEntries(Object.keys(rawLabels).sort().map(key => [key, rawLabels[key]])) as Record<string, string>;
  demand(labels[MANAGED] === 'true' && INSTANCE_ID.test(labels[INSTANCE] ?? ''), 'Invalid network intent owner labels');
  if (labels[BOOTSTRAP] !== undefined) demand(NAME.test(labels[BOOTSTRAP]), 'Invalid network intent bootstrap owner');
  if (labels[PROBE] !== undefined) {
    demand(labels[PROBE] === 'true' && NAME.test(labels[MIGRATION] ?? '') && labels[BOOTSTRAP] === undefined, 'Invalid network intent probe owner');
  } else demand(labels[MIGRATION] === undefined, 'Invalid network intent migration owner');
  const marker = labels[NETWORK_POLICY_OP_LABEL];
  const realm = labels[NETWORK_POLICY_REALM_LABEL];
  if (value.kind === 'create' || realm !== undefined) demand(typeof realm === 'string' && NETWORK_ID.test(realm), 'Invalid network intent deployment realm');
  if (value.kind === 'create') demand(marker === value.opId, 'Invalid network intent operation owner');
  else if (marker !== undefined) demand(OP.test(marker), 'Invalid network intent operation owner');
  if (value.networkId !== undefined) demand(typeof value.networkId === 'string' && NETWORK_ID.test(value.networkId), 'Invalid immutable network ID');
  demand(value.kind !== 'delete' || value.networkId !== undefined, 'Delete intent requires a known network ID');
  return { opId: value.opId, kind: value.kind, name: value.name, labels,
    ...(typeof value.networkId === 'string' ? { networkId: value.networkId } : {}) };
}

function checksum(intent: NetworkIntent): string {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * A single policy process owns this private directory and serializes mutations.
 * No network is authorized or deleted here. Callers must persist begin before a
 * Docker mutation and commit only after verifying its immutable ID and guard.
 */
export class NetworkIntentStore {
  readonly #root: string;
  readonly #rootIdentity: Stats;
  readonly #options: NetworkIntentStoreOptions;
  readonly #maxEntries: number;
  readonly #maxFileBytes: number;
  readonly #uid: number;

  constructor(root: string, options: NetworkIntentStoreOptions = {}) {
    demand(isAbsolute(root) && resolve(root) === root && root !== '/', 'Network intent directory must be an absolute canonical private directory');
    this.#root = root;
    this.#options = options;
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#maxFileBytes = options.maxFileBytes ?? 8192;
    demand(Number.isSafeInteger(this.#maxEntries) && this.#maxEntries > 0 && this.#maxEntries <= 4096, 'Invalid network intent entry limit');
    demand(Number.isSafeInteger(this.#maxFileBytes) && this.#maxFileBytes >= 128 && this.#maxFileBytes <= 65536, 'Invalid network intent size limit');
    demand(typeof process.getuid === 'function', 'Network intent storage requires filesystem ownership support');
    this.#uid = process.getuid();
    let created = false;
    try { mkdirSync(root, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.#rootIdentity = lstatSync(root);
    this.#assertRoot();
    if (created) {
      // Persist the directory entry too: syncing files inside a new directory
      // does not by itself make that directory durable in its parent.
      const parent = openSync(dirname(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    // Validate published state at startup. A corrupt record is never silently skipped.
    this.pending();
  }

  #assertRoot(): void {
    const current = lstatSync(this.#root);
    demand(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, this.#rootIdentity)
      && realpathSync(this.#root) === this.#root, 'Network intent directory changed or is not canonical');
    demand(current.uid === this.#uid && (current.mode & 0o7777) === 0o700, 'Network intent directory must have private owner permissions');
  }

  #assertFile(stat: Stats): void {
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === this.#uid
      && (stat.mode & 0o7777) === 0o600, 'Network intent file must be a private regular file without links');
    demand(stat.size <= this.#maxFileBytes, 'Network intent file size limit exceeded');
  }

  #syncDirectory(): void {
    this.#assertRoot();
    const fd = openSync(this.#root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      demand(sameIdentity(fstatSync(fd), this.#rootIdentity), 'Network intent directory changed');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  #read(path: string): NetworkIntent {
    const before = lstatSync(path); this.#assertFile(before);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); this.#assertFile(opened);
      demand(sameIdentity(before, opened), 'Network intent file changed while opening');
      const bytes = Buffer.alloc(this.#maxFileBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = readSync(fd, bytes, size, bytes.length - size, size);
        if (!read) break;
        size += read;
      }
      const after = fstatSync(fd); this.#assertFile(after);
      demand(size <= this.#maxFileBytes && size === after.size, 'Network intent file size limit or read mismatch');
      demand(sameIdentity(after, lstatSync(path)) && opened.size === after.size
        && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, 'Network intent file changed while reading');
      let envelope: Record<string, unknown>;
      try { envelope = object(JSON.parse(bytes.subarray(0, size).toString('utf8'))); }
      catch { throw new NetworkIntentError('Corrupt network intent file'); }
      onlyKeys(envelope, new Set(['version', 'intent', 'checksum']));
      demand(envelope.version === 1, 'Invalid network intent version');
      const intent = validate(envelope.intent);
      demand(envelope.checksum === checksum(intent), 'Network intent checksum integrity failure');
      return intent;
    } finally { closeSync(fd); }
  }

  pending(): NetworkIntent[] {
    this.#assertRoot();
    const names = readdirSync(this.#root);
    demand(names.length <= this.#maxEntries * 2 + 16, 'Network intent directory entry limit exceeded');
    const intents: NetworkIntent[] = [];
    const networkNames = new Set<string>();
    for (const name of names.sort()) {
      const path = join(this.#root, name);
      this.#assertFile(lstatSync(path));
      // A crash before atomic publication can leave a partial temporary file.
      // begin did not return, so it cannot authorize a Docker call. Retain the
      // evidence, bound its size, and recover only published records.
      if (TEMP_FILE.test(name)) continue;
      demand(/^[a-f0-9]{32}\.json$/.test(name), 'Unknown file in network intent directory');
      const intent = this.#read(path);
      demand(name === `${intent.opId}.json`, 'Network intent filename does not match operation');
      demand(!networkNames.has(intent.name), 'Duplicate unfinished network intent name');
      networkNames.add(intent.name); intents.push(intent);
    }
    demand(intents.length <= this.#maxEntries, 'Network intent capacity limit exceeded');
    return intents;
  }

  #publish(intent: NetworkIntent, previous?: NetworkIntent): void {
    this.#assertRoot();
    demand(readdirSync(this.#root).length < this.#maxEntries * 2 + 16, 'Network intent directory entry capacity limit exceeded');
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, intent, checksum: checksum(intent) })}\n`);
    demand(bytes.length <= this.#maxFileBytes, 'Network intent file size limit exceeded');
    const path = join(this.#root, `${intent.opId}.json`);
    const temporary = join(this.#root, `.${intent.opId}.${randomBytes(16).toString('hex')}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const created = fstatSync(fd);
    let published = false;
    try {
      writeFileSync(fd, bytes);
      this.#options.onWriteStep?.('before-file-sync');
      fsyncSync(fd);
      const written = fstatSync(fd);
      this.#options.onWriteStep?.('before-publish');
      this.#assertRoot();
      const candidate = lstatSync(temporary); this.#assertFile(candidate);
      demand(sameIdentity(written, candidate) && written.size === candidate.size
        && written.ctimeMs === candidate.ctimeMs && written.mtimeMs === candidate.mtimeMs, 'Network intent temporary file changed');
      if (previous) demand(checksum(this.#read(path)) === checksum(previous), 'Network intent changed before publication');
      else {
        let exists = true;
        try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
        demand(!exists, 'Network intent operation already exists');
      }
      renameSync(temporary, path);
      published = true;
      this.#options.onWriteStep?.('after-publish');
      this.#syncDirectory();
      this.#options.onWriteStep?.('after-directory-sync');
    } finally {
      closeSync(fd);
      if (!published) {
        // Only remove this call's own temporary inode. Never unlink a replacement.
        try {
          this.#assertRoot();
          const leftover = lstatSync(temporary); this.#assertFile(leftover);
          if (sameIdentity(created, leftover)) { unlinkSync(temporary); this.#syncDirectory(); }
        } catch { /* Preserve uncertain temporary state for inspection. */ }
      }
    }
  }

  begin(input: NetworkIntent): NetworkIntent {
    const intent = validate(input);
    const entries = this.pending();
    demand(!entries.some(entry => entry.opId === intent.opId || entry.name === intent.name), 'Network intent operation or name already exists');
    demand(entries.length < this.#maxEntries, 'Network intent capacity limit exceeded');
    this.#publish(intent);
    return intent;
  }

  recordCreated(opId: string, networkId: string): NetworkIntent {
    demand(OP.test(opId) && NETWORK_ID.test(networkId), 'Invalid immutable network ID or operation ID');
    const previous = this.pending().find(entry => entry.opId === opId);
    demand(previous?.kind === 'create', 'Create network intent not found');
    demand(previous.networkId === undefined || previous.networkId === networkId, 'Immutable network ID cannot be replaced with a different ID');
    if (previous.networkId === networkId) return previous;
    const next = { ...previous, networkId };
    this.#publish(next, previous);
    return next;
  }

  commit(opId: string): void {
    demand(OP.test(opId), 'Invalid network intent operation ID');
    if (!this.pending().some(entry => entry.opId === opId)) return;
    this.#assertRoot();
    unlinkSync(join(this.#root, `${opId}.json`));
    this.#syncDirectory();
  }
}
