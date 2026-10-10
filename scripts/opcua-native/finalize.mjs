import { resolveBuildProfile } from './profiles.mjs';
import process from 'node:process';
import { URL } from 'node:url';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const profile = resolveBuildProfile(process.env.NODE_RED_PROFILE, process.arch);
if (profile.baseImage !== process.env.NODE_RED_BASE
  || require('/usr/src/node-red/node_modules/node-red/package.json').version !== profile.nodeRed
  || Number(process.versions.node.split('.')[0]) !== profile.nodeMajor) {
  throw Error('Runtime base does not match the selected release profile');
}
const binary = '/opt/build/package/build/Release/opcua_open62541.node';
const addon = require(binary);
if (typeof addon.connectAsync !== 'function'
  || !Function.prototype.toString.call(addon.connectAsync).includes('[native code]')) {
  throw Error('Native ABI smoke failed');
}
const source = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8' }).trim();
const apkPackages = command('apk', ['info', '-v']).split('\n').sort();
const locked = (await readFile(new URL('./' + profile.toolchainFile, import.meta.url), 'utf8'))
  .trim().split('\n').map(value => value.replace('=', '-')).sort();
if (JSON.stringify(apkPackages) !== JSON.stringify(locked)) throw Error('Build toolchain differs from lock');
const buildFilesSha256 = {};
for (const name of ['Dockerfile', 'build.mjs', 'prepare.mjs', 'finalize.mjs', 'patch.mjs', 'profiles.mjs', 'manifest.json', profile.toolchainFile]) {
  buildFilesSha256[name] = sha(await readFile(new URL('./' + name, import.meta.url)));
}
await copyFile(binary, '/out/opcua_open62541.node');
await writeFile('/out/manifest.json', JSON.stringify({
  ...source,
  target: `linux-${process.arch}-musl`,
  buildProfile: profile.name,
  baseImage: process.env.NODE_RED_BASE,
  nodeRed: require('/usr/src/node-red/node_modules/node-red/package.json').version,
  node: process.version,
  napi: process.versions.napi,
  openssl: command('openssl', ['version']),
  compiler: command('c++', ['--version']).split('\n')[0],
  apkPackages,
  buildFilesSha256,
  binarySha256: sha(await readFile(binary)),
  patchSha256: sha(await readFile(new URL('./patch.mjs', import.meta.url))),
  toolchainSha256: sha(await readFile(new URL('./' + profile.toolchainFile, import.meta.url))),
}, null, 2));
// Distribute the original sources and the changed MPL file beside the binary.
await mkdir('/out/source');
for (const [from, to] of [
  ['/opt/build/package.tgz', 'opcua-client-0.6.0.tgz'],
  ['/opt/build/scripts/patch.mjs', 'patch.mjs'],
  ['/opt/build/package/.build/open62541-src/src/client/ua_client_connect.c', 'ua_client_connect.c'],
]) await copyFile(from, '/out/source/' + to);
