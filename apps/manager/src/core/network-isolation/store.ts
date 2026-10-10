import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { NetworkIsolationError, parseDescriptor, type NetworkDescriptor } from './descriptor.ts';

export const MAX_NETWORKS = 256;
const MAX_BYTES = 4 * 1024 ** 2;
export interface DescriptorStore { load(): Promise<NetworkDescriptor[]>; save(descriptors: readonly NetworkDescriptor[]): Promise<void> }
function records(values: readonly NetworkDescriptor[]): NetworkDescriptor[] {
  if (values.length > MAX_NETWORKS) throw new NetworkIsolationError('网络保护记录数量超限');
  const result = values.map(parseDescriptor).sort((a, b) => a.networkId.localeCompare(b.networkId));
  if (new Set(result.map(value => value.networkId)).size !== result.length) throw new NetworkIsolationError('网络保护记录重复');
  return result;
}

/** Private volume only; descriptor durability precedes any kernel policy change. */
export class FileDescriptorStore implements DescriptorStore {
  readonly directory: string;
  readonly file: string;
  #owner: string | undefined;
  constructor(directory: string) {
    if (!isAbsolute(directory) || directory !== resolve(directory) || directory === '/') throw new NetworkIsolationError('网络保护存储目录无效');
    this.directory = directory; this.file = join(directory, 'networks.json');
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.directory) !== this.directory) throw new NetworkIsolationError('网络保护目录必须是独立真实目录');
    await chmod(this.directory, 0o700);
  }
  private async existing(): Promise<boolean> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) throw new NetworkIsolationError('网络保护状态文件不安全');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async ownerId(): Promise<string> {
    await this.prepare();
    const file = join(this.directory, 'owner-id');
    let exists = false;
    try {
      const info = await lstat(file); exists = true;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 || (info.mode & 0o077) !== 0) throw new NetworkIsolationError('网络保护控制域文件不安全');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      if (await this.existing()) throw new NetworkIsolationError('已有网络保护状态但控制域丢失，必须恢复原控制域');
      const value = randomBytes(16).toString('hex');
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(`${value}\n`); await handle.sync(); } finally { await handle.close(); }
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        this.#owner = value;
        return value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(65), result = await handle.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, result.bytesRead).toString('utf8').trim();
      if (!/^[a-f0-9]{32}$/.test(value)) throw new NetworkIsolationError('网络保护控制域损坏，必须恢复原控制域');
      if (this.#owner && this.#owner !== value) throw new NetworkIsolationError('网络保护控制域在运行期间发生变化');
      this.#owner = value;
      return value;
    } finally { await handle.close(); }
  }
  async load(): Promise<NetworkDescriptor[]> {
    await this.prepare();
    if (!await this.existing()) return [];
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(MAX_BYTES + 1); let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_BYTES) throw new NetworkIsolationError('网络保护状态文件过大');
      const value = JSON.parse(bytes.subarray(0, size).toString('utf8')) as { version?: unknown; ownerId?: unknown; networks?: unknown };
      if (!value || value.version !== 1 || !Array.isArray(value.networks) || Object.keys(value).some(key => !['version', 'ownerId', 'networks'].includes(key))) throw new NetworkIsolationError('网络保护状态格式无效');
      if (value.ownerId !== await this.ownerId()) throw new NetworkIsolationError('网络保护状态与控制域不匹配，必须恢复原控制域');
      return records(value.networks as NetworkDescriptor[]);
    } finally { await handle.close(); }
  }
  async save(descriptors: readonly NetworkDescriptor[]): Promise<void> {
    const values = records(descriptors);
    const ownerId = await this.ownerId();
    const bytes = Buffer.from(JSON.stringify({ version: 1, ownerId, networks: values }));
    if (bytes.length > MAX_BYTES) throw new NetworkIsolationError('网络保护状态文件过大');
    await this.prepare(); await this.existing();
    const temporary = join(this.directory, `.networks-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
}
