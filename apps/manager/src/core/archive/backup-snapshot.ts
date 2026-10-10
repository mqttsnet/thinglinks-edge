import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { TarEntry } from './tar.ts';

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** No directory or link is traversed to collect its contents through a symlink. */
export async function snapshotInstance(root: string, prefix: string, excludeNodeModules = false): Promise<{
  entries: TarEntry[]; directories: string[];
}> {
  const base = resolve(root);
  const parentFacts = new Map<string, BigIntStats>();
  const directoryFacts = new Map<string, BigIntStats>();
  const entryFacts = new Map<string, BigIntStats>();
  const linkFacts = new Map<string, string>();
  const entries: TarEntry[] = [];
  const directories: string[] = [];
  let ancestor = parse(base).root;
  for (const segment of base.slice(ancestor.length).split(sep)) {
    ancestor = join(ancestor, segment);
    const fact = await lstat(ancestor, { bigint: true });
    // macOS supplies these system aliases; user-controlled aliases stay forbidden.
    if (process.platform === 'darwin' && (ancestor === '/tmp' || ancestor === '/var')) continue;
    if (!fact.isDirectory() || fact.isSymbolicLink()) throw new Error('备份实例目录或父目录含符号链接/不是普通目录');
    parentFacts.set(ancestor, fact);
  }
  async function checkAncestors(path: string): Promise<void> {
    for (const [name, fact] of parentFacts) {
      const current = await lstat(name, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== fact.dev || current.ino !== fact.ino) {
        throw new Error('备份实例父目录被替换');
      }
    }
    let current = path;
    while (current === base || current.startsWith(`${base}${sep}`)) {
      const fact = directoryFacts.get(current);
      if (fact && !unchanged(fact, await lstat(current, { bigint: true }))) throw new Error('备份期间实例目录发生变化');
      if (current === base) break;
      current = dirname(current);
    }
  }
  async function visit(path: string): Promise<void> {
    await checkAncestors(dirname(path));
    const before = await lstat(path, { bigint: true });
    const rel = relative(base, path).split(sep).join('/');
    const name = rel ? `${prefix}/${rel}` : prefix;
    if (before.isSymbolicLink()) {
      const target = await readlink(path);
      if (!unchanged(before, await lstat(path, { bigint: true }))) throw new Error('备份期间链接发生变化');
      entries.push({ name, content: Buffer.alloc(0), symlink: target, mode: 0o777 });
      linkFacts.set(path, target);
      entryFacts.set(path, before);
    } else if (before.isDirectory()) {
      directoryFacts.set(path, before);
      directories.push(name);
      const names = await readdir(path, { withFileTypes: true });
      await checkAncestors(path);
      for (const entry of names) {
        if (excludeNodeModules && entry.name === 'node_modules') continue;
        await visit(join(path, entry.name));
      }
    } else if (before.isFile()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !unchanged(before, opened)) throw new Error('备份文件打开前发生变化');
        await checkAncestors(dirname(path));
        const size = Number(before.size);
        if (!Number.isSafeInteger(size)) throw new Error('备份文件过大');
        const content = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(content, offset, size - offset, offset);
          if (!bytesRead) throw new Error('备份期间文件被截断');
          offset += bytesRead;
        }
        if (!unchanged(before, await handle.stat({ bigint: true }))
          || !unchanged(before, await lstat(path, { bigint: true }))) throw new Error('备份期间文件发生变化');
        await checkAncestors(dirname(path));
        entries.push({ name, content, mode: Number(before.mode & 0o777n) });
        entryFacts.set(path, before);
      } finally { await handle.close(); }
    } else throw new Error('实例目录含不支持的文件类型');
  }
  await visit(base);
  for (const [path, before] of directoryFacts) {
    if (!unchanged(before, await lstat(path, { bigint: true }))) throw new Error('备份期间实例目录发生变化');
  }
  for (const [path, before] of entryFacts) {
    if (!unchanged(before, await lstat(path, { bigint: true }))) throw new Error('备份期间文件或链接发生变化');
    const target = linkFacts.get(path);
    if (target !== undefined && await readlink(path) !== target) throw new Error('备份期间链接目标发生变化');
  }
  await checkAncestors(base);
  return { entries, directories };
}
