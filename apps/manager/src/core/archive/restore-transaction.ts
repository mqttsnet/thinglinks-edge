/**
 * Offline restore transaction. EDGE_DATA_ROOT is itself a bind mount, so it
 * cannot be swapped. Each controlled unit is renamed on the same filesystem;
 * a durable journal blocks Manager startup until the complete cutover or an
 * explicit rollback has finished. Manager and all target instances must be
 * stopped: this journal is not a lock against an already running service.
 */
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const TRANSACTION = '.restore-transaction';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INITIAL_PARTIAL = new RegExp(`^journal-${UUID}\\.partial$`);
const RETIRED = new RegExp(`^\\.restore-trash-${UUID}$`);
const UNITS = ['manager/edge.db', 'manager/edge.db-wal', 'manager/edge.db-shm', 'instances'] as const;
type UnitPath = typeof UNITS[number];
interface Identity { dev: string; ino: string; kind: 'file' | 'directory' }
interface Unit { path: UnitPath; before: Identity | null; after: Identity | null }
interface Journal {
  version: 1;
  phase: 'staging' | 'prepared' | 'committed' | 'rolled-back';
  units: Unit[];
}

export class RestoreTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreTransactionError';
  }
}

function invalid(message: string): never {
  throw new RestoreTransactionError(`恢复事务：${message}`);
}

async function optionalStat(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function owned(stat: NonNullable<Awaited<ReturnType<typeof optionalStat>>>, mode: number): boolean {
  return Number(stat.mode & 0o777n) === mode
    && (process.getuid === undefined || stat.uid === BigInt(process.getuid()));
}

async function directory(path: string, privateMode = false): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('目录含符号链接或不是可信目录');
  if (privateMode && !owned(stat, 0o700)) invalid('事务目录权限或属主不可信');
}

/** Resolve only macOS system aliases; reject user-controlled symlink components. */
async function dataDirectory(input: string, create: boolean): Promise<string | undefined> {
  if (!isAbsolute(input)) invalid('数据根必须是绝对目录');
  const absolute = resolve(input);
  let current = parse(absolute).root;
  const segments = absolute.slice(current.length).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let stat = await optionalStat(current);
    if (!stat) {
      if (!create) return undefined;
      await mkdir(current, { mode: 0o700 });
      await syncDirectory(dirname(current));
      stat = await lstat(current, { bigint: true });
    }
    if (stat.isSymbolicLink()) {
      if (process.platform === 'darwin' && index < segments.length - 1
        && (current === '/tmp' || current === '/var')) {
        current = await realpath(current);
        await directory(current);
        continue;
      }
      invalid('数据目录含符号链接');
    }
    if (!stat.isDirectory()) invalid('数据路径不是目录');
  }
  if (current === parse(current).root) invalid('不能以文件系统根目录恢复');
  return current;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) invalid('同步目标不是目录');
    await handle.sync();
  } finally { await handle.close(); }
}

async function identity(path: string, kind: Identity['kind']): Promise<Identity | null> {
  const stat = await optionalStat(path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    invalid('恢复目标含符号链接或文件类型不符');
  }
  return { dev: String(stat.dev), ino: String(stat.ino), kind };
}

function equal(a: Identity | null, b: Identity | null): boolean {
  return a === null || b === null ? a === b
    : a.dev === b.dev && a.ino === b.ino && a.kind === b.kind;
}

function kind(path: UnitPath): Identity['kind'] { return path === 'instances' ? 'directory' : 'file'; }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid('journal 字段不合法');
  return value as Record<string, unknown>;
}

function parseIdentity(value: unknown, expected: Identity['kind']): Identity | null {
  if (value === null) return null;
  const raw = object(value, ['dev', 'ino', 'kind']);
  if (raw['kind'] !== expected || typeof raw['dev'] !== 'string' || !/^\d+$/.test(raw['dev'])
    || typeof raw['ino'] !== 'string' || !/^\d+$/.test(raw['ino'])) invalid('journal 文件身份不合法');
  return { dev: raw['dev'], ino: raw['ino'], kind: expected };
}

function parseJournal(value: unknown): Journal {
  const raw = object(value, ['version', 'phase', 'units']);
  if (raw['version'] !== 1 || !['staging', 'prepared', 'committed', 'rolled-back'].includes(String(raw['phase']))
    || !Array.isArray(raw['units'])) invalid('journal 版本或阶段不合法');
  const phase = raw['phase'] as Journal['phase'];
  if (raw['units'].length !== (phase === 'staging' ? 0 : UNITS.length)) invalid('journal 单元数不合法');
  const units = raw['units'].map((value, index): Unit => {
    const entry = object(value, ['path', 'before', 'after']);
    const path = UNITS[index]!;
    if (entry['path'] !== path) invalid('journal 路径不合法');
    const before = parseIdentity(entry['before'], kind(path));
    const after = parseIdentity(entry['after'], kind(path));
    if ((path === 'manager/edge.db' || path === 'instances') !== (after !== null)) {
      invalid('journal 快照单元不合法');
    }
    return { path, before, after };
  });
  return { version: 1, phase, units };
}

async function readJournal(transaction: string): Promise<Journal> {
  await directory(transaction, true);
  const handle = await open(join(transaction, 'journal.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !owned(stat, 0o600) || stat.nlink !== 1n || stat.size > 16_384n) {
      invalid('journal 权限、属主或大小不可信');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await handle.readFile('utf8')) as unknown; }
    catch { invalid('journal 不是合法 JSON'); }
    return parseJournal(parsed);
  } finally { await handle.close(); }
}

/** A missing initial journal is safe only before any stage/old directory exists. */
async function recoveryJournal(transaction: string): Promise<Journal> {
  try { return await readJournal(transaction); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await directory(transaction, true);
    for (const name of await readdir(transaction)) {
      if (!INITIAL_PARTIAL.test(name)) invalid('journal 缺失且存在恢复数据，必须人工检查');
      const stat = await lstat(join(transaction, name), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat, 0o600)
        || stat.nlink !== 1n || stat.size > 16_384n) invalid('初始 journal 临时文件不可信');
    }
    return { version: 1, phase: 'staging', units: [] };
  }
}

async function writeJournal(transaction: string, journal: Journal): Promise<void> {
  const temporary = join(transaction, `journal-${randomUUID()}.partial`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, join(transaction, 'journal.json'));
  await syncDirectory(transaction);
}

async function syncTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) invalid('staging 含符号链接');
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await syncTree(join(path, name));
    await syncDirectory(path);
  } else if (stat.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        invalid('staging 文件身份不可信');
      }
      await handle.sync();
    } finally { await handle.close(); }
  } else invalid('staging 包含非普通文件');
}

async function move(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  await syncDirectory(dirname(source));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(destination));
}

/** Complete states only are retired. A crash during trash deletion cannot trigger rollback. */
async function retire(root: string, transaction: string): Promise<void> {
  await directory(transaction, true);
  const trash = join(root, `.restore-trash-${randomUUID()}`);
  await move(transaction, trash);
  await cleanRetired(trash);
  await syncDirectory(root);
}

async function validateRetired(path: string): Promise<void> {
  const journal = await recoveryJournal(path);
  if (journal.phase === 'prepared') invalid('垃圾目录中的事务尚未终结，拒绝删除');
}

async function cleanRetired(path: string): Promise<void> {
  await validateRetired(path);
  // Keep the terminal journal until every payload has gone. Interrupted rm must
  // never erase recovery authority while old/new plaintext files still remain.
  for (const name of await readdir(path)) {
    if (name !== 'journal.json') await rm(join(path, name), { recursive: true, force: false });
  }
  await syncDirectory(path);
  if (await optionalStat(join(path, 'journal.json'))) await unlink(join(path, 'journal.json'));
  await syncDirectory(path);
  await rmdir(path);
}

async function cleanRetiredTransactions(root: string): Promise<void> {
  const candidates = (await readdir(root)).filter((name) => RETIRED.test(name)).map((name) => join(root, name));
  // Prevalidate all names/ownership/journals before deleting any candidate.
  for (const path of candidates) await validateRetired(path);
  for (const path of candidates) await cleanRetired(path);
  if (candidates.length > 0) await syncDirectory(root);
}

interface Locations {
  unit: Unit;
  live: string;
  old: string;
  staged: string;
  liveIdentity: Identity | null;
  oldIdentity: Identity | null;
  stagedIdentity: Identity | null;
}

async function locations(root: string, transaction: string, unit: Unit): Promise<Locations> {
  const live = join(root, unit.path);
  const old = join(transaction, 'old', unit.path);
  const staged = join(transaction, 'new', unit.path);
  return {
    unit, live, old, staged,
    liveIdentity: await identity(live, kind(unit.path)),
    oldIdentity: await identity(old, kind(unit.path)),
    stagedIdentity: await identity(staged, kind(unit.path)),
  };
}

/** Only the original and staged inode identities may participate in recovery. */
function validateRollbackState(state: Locations): void {
  const { unit, liveIdentity: live, oldIdentity: old, stagedIdentity: staged } = state;
  if (old && !equal(old, unit.before)) invalid('原始回滚副本身份不符');
  if (staged && !equal(staged, unit.after)) invalid('staging 回滚身份不符');
  if (live && !equal(live, unit.before) && !equal(live, unit.after)) invalid('正式目录身份不符');
  if (unit.before && Number(equal(live, unit.before)) + Number(equal(old, unit.before)) !== 1) {
    invalid('原始回滚副本缺失或重复');
  }
  if (unit.after && Number(equal(live, unit.after)) + Number(equal(staged, unit.after)) !== 1) {
    invalid('新快照副本缺失或重复');
  }
  if (!unit.before && old) invalid('出现未授权回滚副本');
  if (!unit.after && staged) invalid('出现未授权 staging 副本');
}

async function rollback(root: string, transaction: string, journal: Journal): Promise<void> {
  await directory(join(root, 'manager'));
  for (const path of ['old', 'old/manager', 'new', 'new/manager']) {
    await directory(join(transaction, path));
  }
  // Validate the entire transaction before the first recovery mutation.
  for (const unit of journal.units) validateRollbackState(await locations(root, transaction, unit));
  for (const unit of [...journal.units].reverse()) {
    const state = await locations(root, transaction, unit);
    validateRollbackState(state);
    if (unit.after && equal(state.liveIdentity, unit.after)) await move(state.live, state.staged);
    if (state.oldIdentity) await move(state.old, state.live);
  }
  for (const unit of journal.units) {
    if (!equal(await identity(join(root, unit.path), kind(unit.path)), unit.before)) {
      invalid('回滚后的正式数据与原始身份不符');
    }
  }
  await writeJournal(transaction, { ...journal, phase: 'rolled-back' });
}

/** Fail closed before opening SQLite, constructing services, or starting HTTP. */
export async function assertNoRestoreTransaction(dataRoot: string): Promise<void> {
  const root = await dataDirectory(dataRoot, false);
  if (root && await optionalStat(join(root, TRANSACTION))) {
    invalid('检测到未完成的 restore；请保持服务停止，执行 restore --recover 后再启动');
  }
}

/** Explicit offline recovery; repeat calls are harmless after completion. */
export async function recoverRestoreTransaction(dataRoot: string): Promise<void> {
  const root = await dataDirectory(dataRoot, false);
  if (!root) return;
  await cleanRetiredTransactions(root);
  const transaction = join(root, TRANSACTION);
  if (!await optionalStat(transaction)) return;
  const journal = await recoveryJournal(transaction);
  if (journal.phase === 'prepared') await rollback(root, transaction, journal);
  await retire(root, transaction);
}

export async function withRestoreTransaction(
  dataRoot: string,
  stage: (root: string) => Promise<void>,
): Promise<void> {
  const root = (await dataDirectory(dataRoot, true))!;
  const transaction = join(root, TRANSACTION);
  try { await mkdir(transaction, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('已有 restore 事务，拒绝并发恢复');
    throw error;
  }
  // Publish the gate before preparing data. Missing journals can be retired only
  // when the directory proves stage/old have not yet been created.
  await syncDirectory(root);
  try {
    await writeJournal(transaction, { version: 1, phase: 'staging', units: [] });
    const temporary = join(transaction, 'new');
    await mkdir(temporary, { mode: 0o700 });
    await mkdir(join(transaction, 'old'), { mode: 0o700 });
    await mkdir(join(transaction, 'old', 'manager'), { mode: 0o700 });
    await stage(temporary);
    if ((await readdir(temporary)).sort().join(',') !== 'instances,manager') invalid('staging 根含未知目录');
    await directory(join(temporary, 'manager'));
    if ((await readdir(join(temporary, 'manager'))).join(',') !== 'edge.db') invalid('staging Manager 内容不合法');
    await syncTree(temporary);
    const manager = join(root, 'manager');
    if (!await optionalStat(manager)) await mkdir(manager, { mode: 0o770 });
    await directory(manager);
    await syncDirectory(root);
    const units: Unit[] = [];
    for (const path of UNITS) {
      const before = await identity(join(root, path), kind(path));
      const after = await identity(join(temporary, path), kind(path));
      if ((path === 'manager/edge.db' || path === 'instances') !== (after !== null)) {
        invalid('staging 缺少数据库或实例目录');
      }
      units.push({ path, before, after });
    }
    const journal: Journal = { version: 1, phase: 'prepared', units };
    await syncDirectory(join(transaction, 'old', 'manager'));
    await syncDirectory(join(transaction, 'old'));
    await writeJournal(transaction, journal);
    for (const unit of units) {
      const state = await locations(root, transaction, unit);
      validateRollbackState(state);
      if (unit.before) await move(state.live, state.old);
      if (unit.after) await move(state.staged, state.live);
    }
    await writeJournal(transaction, { ...journal, phase: 'committed' });
    await retire(root, transaction);
  } catch (failure) {
    try { await recoverRestoreTransaction(root); }
    catch (recoveryFailure) {
      throw new AggregateError([failure, recoveryFailure],
        `恢复事务失败且尚未清理；保持服务停止并执行 restore --recover：${(failure as Error).message}`,
        { cause: recoveryFailure });
    }
    throw failure;
  }
}
