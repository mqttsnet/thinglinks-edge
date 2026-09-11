#!/usr/bin/env node
/* global process, console */
/** Fixed, complete protocol dependency closure. No install, approval or instance mutation. */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PROTOCOL_PACKAGE_PINS } from '../apps/manager/src/core/protocols/catalog.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = join(root, 'scripts/protocol-seed/package-lock.json');
export function lockedProtocolPackages(lock) {
  const roots = lock.packages?.['']?.dependencies ?? {};
  if (JSON.stringify(Object.entries(roots).sort()) !== JSON.stringify(PROTOCOL_PACKAGE_PINS.map((p) => [p.module,p.version]).sort())) {
    throw new Error('Protocol lock root pins differ from the catalogue');
  }
  for (const pin of PROTOCOL_PACKAGE_PINS) {
    const entry = lock.packages[`node_modules/${pin.module}`];
    if (entry?.version !== pin.version || entry?.integrity !== pin.integrity) {
      throw new Error(`Protocol pin integrity mismatch: ${pin.module}`);
    }
  }
  const packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    if (entry.link || entry.dev || !entry.version || !entry.integrity || !entry.resolved?.startsWith('https://')) {
      throw new Error(`Incomplete protocol lock entry: ${path}`);
    }
    const key = `${name}@${entry.version}`;
    const previous = packages.get(key);
    if (previous && previous.integrity !== entry.integrity) throw new Error(`Conflicting lock integrity: ${key}`);
    packages.set(key, {module:name,version:entry.version,integrity:entry.integrity,url:entry.resolved,
      file:`${name.replace(/^@/,'').replaceAll('/','-')}-${entry.version}.tgz`});
  }
  return [...packages.values()].sort((a,b) => `${a.module}@${a.version}`.localeCompare(`${b.module}@${b.version}`));
}

const matches = (bytes, integrity) => {
  const first=integrity.trim().split(/\s+/)[0],dash=first.indexOf('-');
  return createHash(first.slice(0,dash)).update(bytes).digest('base64')===first.slice(dash+1);
};

async function prefetch(packages, directory) {
  await mkdir(directory,{recursive:true});
  let next=0, reused=0, downloaded=0;
  const worker=async()=>{
    while(next<packages.length) {
      const pkg=packages[next++],file=join(directory,pkg.file);
      try {if(matches(await readFile(file),pkg.integrity)){reused++;continue;}}catch { /* absent cached archive */ }
      let lastError;
      for(let attempt=0;attempt<3;attempt++) {
        try {
          const temp=`${file}.part-${process.pid}`;
          // Keep the existing curl proxy behavior on all supported Node versions.
          await new Promise((resolve,reject)=>{
            const child=spawn('curl',['-fsSL','--max-time','60','--output',temp,'--',pkg.url],{stdio:'ignore'});
            child.once('error',reject);
            child.once('exit',(code)=>code===0?resolve():reject(new Error(`curl exited ${code}`)));
          });
          const bytes=await readFile(temp);
          if(!matches(bytes,pkg.integrity))throw new Error('integrity mismatch');
          await rename(temp,file);downloaded++;
          lastError=undefined;break;
        }catch(error){lastError=error;}
      }
      if(lastError)throw new Error(`Protocol download failed: ${pkg.module}@${pkg.version}: ${lastError.message}`);
    }
  };
  const workers=await Promise.allSettled(Array.from({length:6},worker));
  const failed=workers.find((result)=>result.status==='rejected');
  if(failed)throw failed.reason;
  console.log(`Protocol archives: reused ${reused}, downloaded ${downloaded}`);
}

/** A mixed distribution may contain separately governed platform or private package seeds. */
export async function verifyPackageArchives(directory, packages, { allowAdditionalArchives = false } = {}) {
  let bytes = 0;
  for (const pkg of packages) {
    const body = await readFile(join(directory,pkg.file));
    const first = pkg.integrity.trim().split(/\s+/)[0];
    const dash = first.indexOf('-');
    const digest = createHash(first.slice(0,dash)).update(body).digest('base64');
    if (digest !== first.slice(dash+1)) throw new Error(`Protocol seed integrity mismatch: ${pkg.file}`);
    bytes += body.length;
  }
  const expected = new Set(packages.map((p) => p.file));
  const extra = (await readdir(directory)).filter((file) => file.endsWith('.tgz') && !expected.has(file));
  if (!allowAdditionalArchives && extra.length) throw new Error(`Unexpected protocol seed archives: ${extra.join(', ')}`);
  return bytes;
}

export async function verifyProtocolSeed(directory, options = {}) {
  const lockBytes = await readFile(lockFile);
  const packages = lockedProtocolPackages(JSON.parse(lockBytes));
  const bytes = await verifyPackageArchives(directory, packages, options);
  return {version:1,roots:PROTOCOL_PACKAGE_PINS.map(({module,version,integrity}) => ({module,version,integrity})),
    lockSha256:createHash('sha256').update(lockBytes).digest('hex'),packages,bytes};
}

async function main() {
  const args = process.argv.slice(2);
  let out = join(root,'dist-nodes/protocols');
  let verifyOnly = false;
  let allowAdditionalArchives = false;
  for (let i=0;i<args.length;i+=1) {
    if (args[i] === '--out' && args[i+1]) out = resolve(args[++i]);
    else if (args[i] === '--verify-only') verifyOnly = true;
    else if (args[i] === '--allow-additional-archives') allowAdditionalArchives = true;
    else throw new Error('Usage: node --experimental-strip-types scripts/prepare-protocol-seed.mjs [--out dir] [--verify-only [--allow-additional-archives]]');
  }
  if (allowAdditionalArchives && !verifyOnly) throw new Error('Additional archives are only allowed when verifying an existing mixed distribution');
  const packages = lockedProtocolPackages(JSON.parse(await readFile(lockFile,'utf8')));
  if (!verifyOnly) {
    const cache=join(root,'dist-nodes/.protocol-cache');
    await prefetch(packages,cache);
    const argv = [join(root,'scripts/pack-nodes.sh'),'--lock-file',lockFile,'--download-cache',cache,'--out',out];
    for (const pkg of packages) argv.push('--expect',`${pkg.module}@${pkg.version}=${pkg.integrity}`);
    await new Promise((resolve,reject) => {
      const child = spawn('bash',argv,{stdio:'inherit'});
      child.once('error',reject);
      child.once('exit',(code) => code === 0 ? resolve() : reject(new Error(`Protocol seed preparation exited ${code}`)));
    });
  }
  const manifest = await verifyProtocolSeed(out, { allowAdditionalArchives });
  if (!verifyOnly) {
    const manifestPath=join(out,'protocol-seed-manifest.json');
    await writeFile(`${manifestPath}.next`,JSON.stringify(manifest,null,2)+'\n');
    await rename(`${manifestPath}.next`,manifestPath);
  }
  console.log(`Protocol seed verified: ${manifest.packages.length} archives, ${manifest.bytes} bytes, ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode=1; });
}
