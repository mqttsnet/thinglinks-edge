/**
 * 备份与恢复（T4.3）。
 *
 * 备份的是「一个目录」：`<dataRoot>/manager/edge.db` 与 `<dataRoot>/instances/<id>/`。
 * 这与 `.env.example` 里那句「排障、备份、迁移都只认这一个目录」是同一个约定。
 *
 * 三个必须做对的地方：
 *
 * 1. **库要一致性快照，不能直接拷文件**。库跑在 WAL 模式，已提交的数据可能还在
 *    `-wal` 里 —— 只拷 `edge.db` 会拿到一个缺数据的库，而且**打得开、看着正常**。
 *    这里用 better-sqlite3 的在线备份 API 产出单文件快照
 * 2. **要记 `MASTER_KEY` 指纹**。实例凭据用它加密，异机恢复时密钥不对，
 *    恢复出来的系统能启动、能登录，但**所有实例凭据都解不开**，
 *    表现是「实例起不来」而不是「密钥错了」。指纹让恢复端当场失败并说清原因
 * 3. **恢复是离线操作**。库正被 Manager 打开时覆盖它是自找损坏，
 *    因此恢复不做成在线接口，走 CLI，恢复完再启动
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { tarArchive, untar, type TarEntry } from './tar.ts';
import type { Db } from '../db.ts';

export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  format: number;
  product: 'thinglinks-edge';
  createdAt: string;
  schemaVersion: number;
  /** `MASTER_KEY` 派生密钥的指纹，不含密钥本身 */
  masterKeyFingerprint: string;
  instances: { id: string; name: string; imageTag: string }[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** 指纹取派生密钥的 SHA-256 前 16 位十六进制 —— 够区分，且反推不出密钥 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 目录内所有文件的相对路径（POSIX 风格，tar 里用它） */
async function walk(root: string, base = root): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...await walk(full, base));
    else if (e.isFile()) out.push(relative(base, full).split(sep).join(posix.sep));
  }
  return out;
}

export interface CreateBackupOptions {
  db: Db;
  key: Buffer;
  instanceDataRoot: string;
  instances: { id: string; name: string; imageTag: string }[];
  schemaVersion: number;
  /** 排除实例里的 node_modules。默认**不排除** —— 少了它恢复出来的实例可能缺节点 */
  excludeNodeModules?: boolean;
}

export async function createBackup(opts: CreateBackupOptions): Promise<Buffer> {
  const entries: TarEntry[] = [];

  // 1. 库的一致性快照。落到临时文件再读回来，避免与在用的库文件抢写
  const snapshot = join(await mkdtemp(), 'edge.db');
  await opts.db.backup(snapshot);
  entries.push({ name: 'manager/edge.db', content: await readFile(snapshot) });
  await rm(snapshot, { force: true });

  // 2. 每个实例的数据目录
  for (const inst of opts.instances) {
    const dir = join(opts.instanceDataRoot, inst.id);
    for (const rel of await walk(dir)) {
      if (opts.excludeNodeModules && rel.split(posix.sep).includes('node_modules')) continue;
      entries.push({
        name: `instances/${inst.id}/${rel}`,
        content: await readFile(join(dir, rel.split(posix.sep).join(sep))),
      });
    }
  }

  // 3. 清单放最后写、最前面读 —— 内容与实际归档一致
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    product: 'thinglinks-edge',
    createdAt: new Date().toISOString(),
    schemaVersion: opts.schemaVersion,
    masterKeyFingerprint: keyFingerprint(opts.key),
    instances: opts.instances,
  };
  entries.unshift({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });

  return tarArchive(entries);
}

async function mkdtemp(): Promise<string> {
  const dir = join(tmpdir(), `tle-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function readManifest(archive: Buffer): BackupManifest {
  const entries = untar(archive);
  const m = entries.find((e) => e.name === 'manifest.json');
  if (!m) throw new BackupError('归档里没有 manifest.json，不是本平台的备份');
  let parsed: BackupManifest;
  try {
    parsed = JSON.parse((m.content as Buffer).toString('utf8')) as BackupManifest;
  } catch {
    throw new BackupError('manifest.json 不是合法 JSON');
  }
  if (parsed.product !== 'thinglinks-edge') {
    throw new BackupError(`不是本平台的备份（product=${parsed.product}）`);
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new BackupError(`备份格式版本 ${parsed.format} 与当前 ${BACKUP_FORMAT} 不符`);
  }
  return parsed;
}

export interface RestoreOptions {
  archive: Buffer;
  dataRoot: string;
  /** 当前 `MASTER_KEY` 派生出的密钥，用于比对指纹 */
  key: Buffer;
  /** 跳过密钥指纹校验。**只应在明知凭据会失效时使用** */
  ignoreKeyMismatch?: boolean;
}

/**
 * 恢复到指定数据根。**必须在 Manager 未运行时执行** —— 覆盖正被打开的库会损坏它。
 *
 * 密钥指纹不符时默认拒绝：让它当场失败，好过恢复出一个「能启动但实例全起不来」的系统。
 */
export async function restoreBackup(opts: RestoreOptions): Promise<BackupManifest> {
  const manifest = readManifest(opts.archive);
  const fp = keyFingerprint(opts.key);
  if (manifest.masterKeyFingerprint !== fp && opts.ignoreKeyMismatch !== true) {
    throw new BackupError(
      `MASTER_KEY 与备份不符（备份 ${manifest.masterKeyFingerprint} / 当前 ${fp}）。` +
      '用错密钥恢复出来的系统能启动，但所有实例凭据都解不开 —— 请改用备份时的 MASTER_KEY。',
    );
  }

  for (const e of untar(opts.archive)) {
    if (e.name === 'manifest.json') continue;
    // 防目录穿越：归档里只应有 manager/ 与 instances/ 两个前缀
    if (e.name.includes('..') || e.name.startsWith('/')) {
      throw new BackupError(`归档含非法路径：${e.name}`);
    }
    if (!e.name.startsWith('manager/') && !e.name.startsWith('instances/')) {
      throw new BackupError(`归档含未知条目：${e.name}`);
    }
    const target = join(opts.dataRoot, ...e.name.split(posix.sep));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, e.content as Buffer);
  }

  // WAL 残留必须清掉：恢复的是完整快照，旧的 -wal/-shm 会把它拖回旧状态
  for (const suffix of ['-wal', '-shm']) {
    await rm(join(opts.dataRoot, 'manager', `edge.db${suffix}`), { force: true });
  }

  return manifest;
}

/** 备份内容概览，给控制台展示用 */
export async function inspectBackup(archive: Buffer): Promise<{
  manifest: BackupManifest; files: number; bytes: number;
}> {
  const entries = untar(archive);
  return {
    manifest: readManifest(archive),
    files: entries.length,
    bytes: entries.reduce((n, e) => n + (e.content as Buffer).length, 0),
  };
}

/** 供 CLI 打印用 */
export async function statPath(p: string): Promise<number> {
  return stat(p).then((s) => s.size).catch(() => 0);
}
