import process from 'node:process';
import { URL } from 'node:url';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { applyChainFix } from './patch.mjs';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url)));
if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch)
  || process.versions.node.split('.')[0] !== '24') {
  throw Error('Unsupported native target: Linux musl Node 24 arm64/x64 required');
}
const archive = await readFile('/opt/build/package.tgz');
if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== manifest.packageIntegrity) {
  throw Error('Official package integrity mismatch');
}
await mkdir('/opt/build/package');
execFileSync('tar', ['-xzf', '/opt/build/package.tgz', '-C', '/opt/build/package', '--strip-components=1']);
const vendor = '/opt/build/package/vendor/open62541-v1.4.16.tar.gz';
if (createHash('sha256').update(await readFile(vendor)).digest('hex') !== manifest.vendorSha256) {
  throw Error('Bundled source integrity mismatch');
}
const directory = '/opt/build/package/.build/open62541-src';
await mkdir(directory, { recursive: true });
execFileSync('tar', ['-xzf', vendor, '-C', directory, '--strip-components=1']);
const sourceFile = directory + '/src/client/ua_client_connect.c';
await writeFile(sourceFile, applyChainFix(await readFile(sourceFile)));
await mkdir('/out/licenses', { recursive: true });
for (const [from, to] of [
  ['/opt/build/package/LICENSE', 'opcua-client-LICENSE'],
  [directory + '/LICENSE', 'open62541-LICENSE'],
  ['/opt/build/package/node_modules/node-addon-api/LICENSE.md', 'node-addon-api-LICENSE'],
]) await copyFile(from, '/out/licenses/' + to);
