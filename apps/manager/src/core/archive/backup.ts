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
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp as makeTempDir, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { tarArchive, untar, type TarEntry } from './tar.ts';
import { withRestoreTransaction } from './restore-transaction.ts';
import { assertValidId } from '../instance/container-spec.ts';
import type { Db } from '../db.ts';

/**
 * v2 encrypts the complete tar stream. The manifest is intentionally inside the
 * ciphertext: instance names, image tags, and the key fingerprint are all
 * operational metadata that must not be exposed by a copied backup file.
 */
export const BACKUP_FORMAT = 2;
const LEGACY_BACKUP_FORMAT = 1;
export const BACKUP_CONTENT_TYPE = 'application/vnd.thinglinks-edge.backup';
export const BACKUP_FILE_EXTENSION = '.tle-backup';
const ENCRYPTED_BACKUP_MAGIC = Buffer.from('TLEBACK2', 'ascii');
const BACKUP_IV_BYTES = 12;
const BACKUP_TAG_BYTES = 16;
const BACKUP_AAD = ENCRYPTED_BACKUP_MAGIC;

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

/**
 * Instance credentials and backups both originate at MASTER_KEY, but must not
 * share an AES key. HKDF gives this file format an independent, versioned key
 * without requiring the raw MASTER_KEY to be retained by the repository layer.
 */
function backupEncryptionKey(key: Buffer): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    key,
    Buffer.alloc(0),
    Buffer.from('thinglinks-edge:backup:v2', 'utf8'),
    32,
  ));
}

export function isEncryptedBackup(archive: Buffer): boolean {
  return archive.length >= ENCRYPTED_BACKUP_MAGIC.length
    && archive.subarray(0, ENCRYPTED_BACKUP_MAGIC.length).equals(ENCRYPTED_BACKUP_MAGIC);
}

function encryptBackupArchive(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(BACKUP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', backupEncryptionKey(key), iv);
  cipher.setAAD(BACKUP_AAD);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ENCRYPTED_BACKUP_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptBackupArchive(archive: Buffer, key: Buffer): Buffer {
  const headerLength = ENCRYPTED_BACKUP_MAGIC.length + BACKUP_IV_BYTES + BACKUP_TAG_BYTES;
  if (archive.length <= headerLength) throw new BackupError('备份加密封装不完整');
  const ivStart = ENCRYPTED_BACKUP_MAGIC.length;
  const tagStart = ivStart + BACKUP_IV_BYTES;
  const ciphertextStart = tagStart + BACKUP_TAG_BYTES;
  const decipher = createDecipheriv(
    'aes-256-gcm', backupEncryptionKey(key), archive.subarray(ivStart, tagStart),
  );
  decipher.setAAD(BACKUP_AAD);
  decipher.setAuthTag(archive.subarray(tagStart, ciphertextStart));
  try {
    return Buffer.concat([decipher.update(archive.subarray(ciphertextStart)), decipher.final()]);
  } catch {
    // Do not disclose whether the failure was a wrong key or modified bytes.
    throw new BackupError('备份解密失败：主密钥不匹配或文件已被篡改');
  }
}

function openBackupArchive(archive: Buffer, key?: Buffer): Buffer {
  if (!isEncryptedBackup(archive)) return archive;
  if (!key) throw new BackupError('加密备份需要主密钥才能读取内容');
  return decryptBackupArchive(archive, key);
}

/** 目录内所有文件的相对路径（POSIX 风格，tar 里用它） */
async function walk(root: string, base = root, excludeNodeModules = false): Promise<string[]> {
  const out: string[] = [];
  // A listed instance (including every nested directory) must be readable.
  // ENOENT is also an error: otherwise a disappearing instance looks backed up.
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (excludeNodeModules && e.name === 'node_modules') continue;
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...await walk(full, base, excludeNodeModules));
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
  const snapshotDir = await mkdtemp();
  const snapshot = join(snapshotDir, 'edge.db');
  try {
    await opts.db.backup(snapshot);
    entries.push({ name: 'manager/edge.db', content: await readFile(snapshot) });
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }

  // 2. 每个实例的数据目录
  for (const inst of opts.instances) {
    assertValidId(inst.id);
    const dir = join(opts.instanceDataRoot, inst.id);
    for (const rel of await walk(dir, dir, opts.excludeNodeModules)) {
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

  return encryptBackupArchive(tarArchive(entries), opts.key);
}

async function mkdtemp(): Promise<string> {
  return makeTempDir(join(tmpdir(), 'tle-backup-'));
}

function readManifestFromTar(archive: Buffer, encrypted: boolean): BackupManifest {
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
  if (parsed.format !== BACKUP_FORMAT && parsed.format !== LEGACY_BACKUP_FORMAT) {
    throw new BackupError(`备份格式版本 ${parsed.format} 与当前 ${BACKUP_FORMAT} 不符`);
  }
  if (parsed.format === BACKUP_FORMAT && !encrypted) {
    throw new BackupError('v2 备份必须使用加密封装');
  }
  return parsed;
}

/** Read an encrypted v2 backup, or a legacy v1 tar retained for recovery compatibility. */
export function readManifest(archive: Buffer, key?: Buffer): BackupManifest {
  const encrypted = isEncryptedBackup(archive);
  return readManifestFromTar(openBackupArchive(archive, key), encrypted);
}

export interface RestoreOptions {
  archive: Buffer;
  dataRoot: string;
  /** 当前 `MASTER_KEY` 派生出的密钥，用于比对指纹 */
  key: Buffer;
  /** 跳过密钥指纹校验。**只应在明知凭据会失效时使用** */
  ignoreKeyMismatch?: boolean;
}

/** Validate every destination before creating a transaction or touching live data. */
function restoreEntries(archive: Buffer, manifest: BackupManifest): TarEntry[] {
  if (!Array.isArray(manifest.instances)) throw new BackupError('清单 instances 必须为数组');
  const ids = new Set<string>();
  for (const inst of manifest.instances) {
    if (!inst || typeof inst.id !== 'string') throw new BackupError('清单实例 id 非法');
    try { assertValidId(inst.id); } catch { throw new BackupError('清单实例 id 非法'); }
    if (ids.has(inst.id)) throw new BackupError('清单实例 id 重复');
    ids.add(inst.id);
  }
  const entries = untar(archive);
  const names = new Set<string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    if (entry.name.includes('\\') || entry.name.includes('\0')
      || parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new BackupError(`归档含非法路径：${entry.name}`);
    }
    if (names.has(entry.name)) throw new BackupError(`归档含重复路径：${entry.name}`);
    names.add(entry.name);
    if (entry.name === 'manifest.json' || entry.name === 'manager/edge.db') continue;
    if (parts[0] !== 'instances' || parts.length < 3 || !ids.has(parts[1]!)) {
      throw new BackupError(`归档含未知条目：${entry.name}`);
    }
  }
  if (!names.has('manager/edge.db')) throw new BackupError('归档缺少 manager/edge.db 快照');
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (names.has(parts.slice(0, i).join('/'))) {
        throw new BackupError(`归档中文件与目录冲突：${name}`);
      }
    }
  }
  return entries.filter((entry) => entry.name !== 'manifest.json');
}

/**
 * 恢复到指定数据根。Manager 和所有目标 Node-RED 容器必须停止，且不能有其他写入者。
 * 数据根可为挂载点；其内部通过持久化事务、目录 rename 和启动门禁实现离线恢复。
 *
 * 密钥指纹不符时默认拒绝：让它当场失败，好过恢复出一个「能启动但实例全起不来」的系统。
 */
export async function restoreBackup(opts: RestoreOptions): Promise<BackupManifest> {
  const encrypted = isEncryptedBackup(opts.archive);
  const archive = openBackupArchive(opts.archive, opts.key);
  const manifest = readManifestFromTar(archive, encrypted);
  const fp = keyFingerprint(opts.key);
  if (manifest.masterKeyFingerprint !== fp && opts.ignoreKeyMismatch !== true) {
    throw new BackupError(
      `MASTER_KEY 与备份不符（备份 ${manifest.masterKeyFingerprint} / 当前 ${fp}）。` +
      '用错密钥恢复出来的系统能启动，但所有实例凭据都解不开 —— 请改用备份时的 MASTER_KEY。',
    );
  }

  const entries = restoreEntries(archive, manifest);
  await withRestoreTransaction(opts.dataRoot, async (stageRoot) => {
    await mkdir(join(stageRoot, 'manager'), { recursive: true });
    await mkdir(join(stageRoot, 'instances'), { recursive: true });
    for (const inst of manifest.instances) {
      await mkdir(join(stageRoot, 'instances', inst.id));
    }
    for (const entry of entries) {
      const target = join(stageRoot, ...entry.name.split(posix.sep));
      await mkdir(join(target, '..'), { recursive: true });
      // The private staging tree contains only directories we created. Exclusive
      // creation never follows an existing file or symlink, even on a collision.
      await writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
    }
    // WAL/SHM are deliberately absent: the transaction removes the old pair
    // with the same rollback guarantees as the database and instance tree.
  });

  return manifest;
}

/** 备份内容概览，给控制台展示用 */
export async function inspectBackup(archive: Buffer, key?: Buffer): Promise<{
  manifest: BackupManifest; files: number; bytes: number;
}> {
  const encrypted = isEncryptedBackup(archive);
  const tar = openBackupArchive(archive, key);
  const entries = untar(tar);
  return {
    manifest: readManifestFromTar(tar, encrypted),
    files: entries.length,
    bytes: entries.reduce((n, e) => n + (e.content as Buffer).length, 0),
  };
}

/** 供 CLI 打印用 */
export async function statPath(p: string): Promise<number> {
  return stat(p).then((s) => s.size).catch(() => 0);
}
