import { posix } from 'node:path';
import type { TarEntry } from './tar.ts';

/** Validate a complete archive namespace without following any filesystem link. */
export function validateBackupLinks(entries: readonly TarEntry[], directories: readonly string[]): Map<string, string> {
  const files = new Map(entries.map(entry => [entry.name, entry]));
  const dirs = new Set(directories);
  for (const name of [...files.keys(), ...dirs]) {
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index++) dirs.add(segments.slice(0, index).join('/'));
  }
  for (const name of files.keys()) {
    if (dirs.has(name)) throw new Error(`备份文件或链接被用作目录：${name}`);
  }
  const links = new Map(entries.filter(entry => entry.symlink !== undefined)
    .map(entry => [entry.name, entry.symlink!]));
  for (const [name, target] of links) {
    const source = name.split('/');
    if (source[0] !== 'instances' || source.length < 3) throw new Error('符号链接只能位于实例目录内');
    const instanceRoot = source.slice(0, 2).join('/');
    const resolveTarget = (value: string) => {
      if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)
        || value.includes('\\') || value.includes('\0') || Buffer.byteLength(value) > 4096) {
        throw new Error(`符号链接必须使用受管相对路径：${name}`);
      }
      return value.split('/');
    };
    let rest = resolveTarget(target);
    const resolved = posix.dirname(name).split('/');
    let hops = 0;
    while (rest.length) {
      const segment = rest.shift()!;
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (resolved.length <= 2) throw new Error(`符号链接越过实例根目录：${name}`);
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, segment].join('/');
      const linked = links.get(candidate);
      if (linked !== undefined) {
        if (++hops > 40) throw new Error(`符号链接循环或链过长：${name}`);
        rest = [...resolveTarget(linked), ...rest];
      } else {
        const directory = dirs.has(candidate);
        if (!directory && !files.has(candidate)) throw new Error(`符号链接目标不在备份中：${name}`);
        if (!directory && rest.length) throw new Error(`符号链接目标将文件当作目录：${name}`);
        resolved.push(segment);
      }
    }
    const destination = resolved.join('/');
    if (destination !== instanceRoot && !destination.startsWith(`${instanceRoot}/`)) {
      throw new Error(`符号链接目标不在同一实例：${name}`);
    }
  }
  return links;
}
