import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CryptoError, requireMasterKey } from './crypto.ts';

interface FirstStart {
  databasePath: string;
  instanceDataRoot: string;
}

const hasCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException)?.code === code;

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`../`));
}

function readKey(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new CryptoError('无法安全读取密钥文件，请检查文件权限及符号链接');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new CryptoError('密钥文件必须是私有普通文件（权限 0600 或 0400），且不能超过 4096 字节');
    }
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const key = bytes.subarray(0, count).toString('utf8').trim();
    if (count > 4096 || !key) throw new CryptoError('密钥文件为空或无效，拒绝自动替换');
    // A concurrent publisher may have linked the file but not synced its directory yet.
    // Every consumer must complete that barrier before it can create/restore a database.
    fsyncSync(fd);
    const parent = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return key;
  } finally { closeSync(fd); }
}

function hasData(options: FirstStart): boolean {
  try {
    lstatSync(options.databasePath);
    return true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw new CryptoError('无法检查已有数据，拒绝生成密钥');
  }
  try { return readdirSync(options.instanceDataRoot).length > 0; }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw new CryptoError('无法检查已有实例数据，拒绝生成密钥');
  }
}

/** Publish a fully written private file without replacing a concurrent winner. */
function publishKey(file: string, key: string): string {
  const parent = dirname(file);
  const temporary = join(parent, `.master-key-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, key, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    try { linkSync(temporary, file); }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  } finally { unlinkSync(temporary); }
  const persisted = readKey(file);
  if (!persisted) throw new CryptoError('密钥文件未成功持久化，拒绝启动');
  return persisted;
}

/**
 * File mode is opt-in. Only Manager's first-start path may initialize it;
 * restore and other read-only consumers must never invent a replacement key.
 * Existing MASTER_KEY deployments retain their encryption identity.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env, initialize?: FirstStart): string {
  const file = env['MASTER_KEY_FILE']?.trim();
  if (!file) return requireMasterKey(env);
  if (!isAbsolute(file) || resolve(file) !== file) throw new CryptoError('密钥文件必须使用规范的绝对路径');
  try {
    if (realpathSync(dirname(file)) !== dirname(file)) throw new Error('symbolic parent');
  } catch {
    throw new CryptoError('密钥文件所在目录必须已存在，且不能通过符号链接访问');
  }
  if (initialize && (inside(dirname(initialize.databasePath), file) || inside(initialize.instanceDataRoot, file))) {
    throw new CryptoError('密钥文件必须独立于 Manager 和实例数据目录，避免随业务备份或实例挂载泄露');
  }
  const explicit = env['MASTER_KEY']?.trim();
  const persisted = readKey(file);
  if (persisted) {
    if (explicit && explicit !== persisted) throw new CryptoError('MASTER_KEY 与密钥文件不一致，拒绝覆盖或切换加密身份');
    return persisted;
  }
  if (!initialize) {
    if (explicit) return explicit;
    throw new CryptoError('密钥文件不存在，请恢复原密钥文件；此命令不会自动生成密钥');
  }
  if (!explicit && hasData(initialize)) {
    throw new CryptoError('已有数据但密钥文件缺失，请恢复原密钥或提供原 MASTER_KEY，拒绝生成替代密钥');
  }
  if (explicit && Buffer.byteLength(explicit, 'utf8') > 4096) throw new CryptoError('密钥超过文件模式的 4096 字节上限');
  const key = publishKey(file, explicit || randomBytes(32).toString('hex'));
  if (explicit && explicit !== key) throw new CryptoError('MASTER_KEY 与并发生成的密钥文件不一致，拒绝启动');
  return key;
}
