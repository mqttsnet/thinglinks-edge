# Protocol component seed

This is the fixed dependency lock for the first protocol component delivery. Root package versions and their published SHA512 digests live in `apps/manager/src/core/protocols/catalog.ts`. The lock includes every resolved dependency and optional dependency; a normal build consumes this lock without resolving newer versions.

Prepare the archives on a connected build machine:

```sh
node --experimental-strip-types scripts/prepare-protocol-seed.mjs
node --experimental-strip-types scripts/prepare-protocol-seed.mjs --verify-only
```

The output is `dist-nodes/protocols/`: original upstream tarballs plus a manifest recording each package digest and the lock digest. A partial or corrupt download does not replace the preceding seed directory. Keep the archives out of Git.

Use the existing offline distribution entry point:

```sh
NODE_SEED_DIR=dist-nodes/protocols ./scripts/build-offline-bundle.sh
```

Seed import makes packages available for installation; it never approves a package or installs/restarts an existing instance. Approve exact driver versions, explicitly apply the policy to the intended instance, then use the normal node installation action. Runtime loading, simulator acquisition, physical-device access and ThingLinks cloud acceptance are separate checks. Modbus-RTU remains blocked by the absence of controlled serial-device passthrough.

New managed containers set `XDG_CONFIG_HOME=/data/.config` so OPC UA libraries can create their configuration beneath the existing writable instance mount while the image stays read-only. An already-created container needs an explicitly scheduled rebuild to acquire that environment setting; importing a seed or installing a node does not alter its container environment.

The isolated acceptance script checks the seed first, creates its own internal Docker network and an offline registry, and installs the fixed drivers and platform nodes into a new Node-RED 5.0.4 / Node 24 instance:

```sh
node --experimental-strip-types scripts/verify-protocol-components.mjs
```

It requires the already-present `nodered/node-red:5.0.4-24-minimal` and `node:24.19.0-alpine` images. Platform node tarballs are fetched and digest-checked before the isolated network is created. Protocol installation itself has no external network. `--keep` retains only successfully verified task-owned resources for additional recipe tests; use the printed state file with `--cleanup` afterward.

Version selection used the publishers' registry metadata and inspected the integrity-matched package archives on 2026-09-09:

- [node-red-contrib-modbus 5.60.2](https://registry.npmjs.org/node-red-contrib-modbus/5.60.2)
- [node-red-contrib-opcua 0.2.355](https://registry.npmjs.org/node-red-contrib-opcua/0.2.355)
- [node-red-contrib-s7 3.1.3](https://registry.npmjs.org/node-red-contrib-s7/3.1.3)

Refreshing the lock is a reviewed version change. Resolve all dependencies including optional packages in a new empty directory with the official registry, inspect changes and archive metadata, update the catalogue pins, and rerun isolated acceptance. Do not substitute a root-package-only download for the closure.
