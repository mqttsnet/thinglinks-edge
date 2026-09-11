/** Registry fixtures need source modules, not the host repository's .env, Git metadata or data. */
export function registrySourceMounts(root) {
  return [
    'apps/manager/src',
    'scripts/verify-protocol-components.mjs',
    'scripts/prepare-protocol-seed.mjs',
    'scripts/protocol-fixtures/source-mounts.mjs',
    'scripts/protocol-wire-lab/serial/registry.mjs',
  ].flatMap(path => ['--mount', `type=bind,src=${root}/${path},dst=/repo/${path},readonly`]);
}
