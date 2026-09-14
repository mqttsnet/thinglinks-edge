import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
/** The release matrix is trusted source; a caller cannot supply an arbitrary base. */
export function resolveBuildProfile(name, arch) {
  const profile = Object.hasOwn(manifest.buildProfiles, name) ? manifest.buildProfiles[name] : undefined;
  const baseImage = profile && Object.hasOwn(profile.images, arch) ? profile.images[arch] : undefined;
  if (!baseImage) throw Error('Unsupported or unverified native build profile/platform');
  return { name, baseImage, nodeRed: profile.nodeRed, nodeMajor: profile.nodeMajor, libc: profile.libc, toolchainFile: profile.toolchainFile };
}
