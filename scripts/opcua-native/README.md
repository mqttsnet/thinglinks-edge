# OPC UA certificate-chain compatibility artifact

This is a separately identified native artifact, `thinglinks-opcua-native 0.6.0-chain.1`. It is **not** a republished or modified `@tier0/opcua-client@0.6.0` npm package. Installing that package still requires the existing fixed-version approval. Its original archive, integrity, version and JavaScript implementation remain unchanged.

The runtime image supplies the artifact through the package's existing `OPCUA_OPEN62541_ADDON` extension point. The fixed path is `/opt/thinglinks/opcua-native/opcua_open62541.node`. It is root-owned and read-only in the image; managed containers have a read-only root filesystem. Instance data must never supply a native override. Ordinary Node-RED images do not automatically acquire this fix.

## Exact scope

The original package bundles open62541 1.4.16. It compares the OPN sender's first DER certificate with the entire EndpointDescription certificate chain. Equivalent full chains therefore fail. Its CreateSession comparison also requires identical chain representation.

`patch.mjs` checks the exact upstream file digest before changing two identity comparisons to the existing OpenSSL SecurityPolicy `compareCertificate` operation. This compares X.509 certificate identity, including serial/signature, rather than merely public-key equality. The OPN approach follows [open62541 v1.5.8](https://github.com/open62541/open62541/blob/v1.5.8/src/client/ua_client_connect.c), adapted to the 1.4 plugin ABI. The CreateSession correction applies the same identity rule. [OPC 10000-6 §6.2.6](https://reference.opcfoundation.org/specs/OPC-10000-6/6.2#6.2.6) allows partial/full DER chains and places the end certificate first.

Full-chain trust and revocation validation in `unpackPayloadOPN`, the receiver-certificate thumbprint, nonce/signature verification, and application-identity checks are retained. No accept-all trust callback, certificate rewriting on the network, or security-mode downgrade is introduced. This is a compatibility correction, not an upgrade of the whole open62541 implementation.

## Build and selection

Build targets are selected from explicit profiles in `manifest.json`; every base is pinned by its platform-specific image digest:

| Profile | Architectures | Node version in the pinned base |
| --- | --- | --- |
| `5.0.4-24-minimal` | Linux musl ARM64, x64 | 24.18.1 |
| `5.0.7-24-minimal` | Linux musl ARM64 | 24.20.0 |

Other operating systems, libc families, Node versions and Node-RED releases require their own build and runtime acceptance. The build rejects unsupported combinations, including 5.0.7 x64. A stock Node-RED 5.0.7 image still does not contain this separately built compatibility artifact.

From the repository root:

```sh
node scripts/opcua-native/build.mjs --arch=arm64 --tag=local/thinglinks-node-red:5.0.4-24-minimal-opcua-chain.1
node scripts/opcua-native/build.mjs --arch=x64 --tag=local/thinglinks-node-red:5.0.4-24-minimal-opcua-chain.1-amd64
node scripts/opcua-native/build.mjs --profile=5.0.7-24-minimal --arch=arm64 --tag=local/thinglinks-node-red:5.0.7-24-minimal-opcua-chain.1
```

An offline public package archive can be supplied with `--archive=/path/opcua-client-0.6.0.tgz`; its SRI is checked before extraction. The script does not publish images, change Manager configuration, approve node packages, or migrate existing instances.

The profile's toolchain lock (`toolchain.apk.lock` or `toolchain-5.0.7.apk.lock`) fixes its complete observed Alpine package set. The signed distribution packages must remain available, or the build fails. Archive the immutable builder image and signed package cache for long-term reproducibility; this repository does not host Alpine packages. `SOURCE_DATE_EPOCH` and the build directory are fixed. Byte-for-byte output equality across different Docker/toolchain hosts is not assumed.

The final image contains no compiler toolchain added by this build. `/opt/thinglinks/opcua-native/manifest.json` records package/vendor/patch/toolchain hashes, output SHA-256, architecture, Node/N-API, Node-RED, base image and compiler/OpenSSL versions. The original package archive and modified MPL source file are included under `source/`, with licenses under `licenses/`.

Before selecting an image, inspect its `com.mqttsnet.thinglinks-edge.opcua-native` label and artifact manifest, and perform a fresh-instance protocol acceptance. The image repository/tag must be explicitly allowed by the trusted deployment policy; an administrator choosing the stock image must not be told that the chain fix is active. Rebuilding or migrating existing instances remains a separate authorized operation.

## Verification

```sh
node --test scripts/opcua-native/*.test.mjs
node --experimental-strip-types --test apps/manager/src/core/instance/container-isolation-native.test.ts
```

Tests verify the pinned patch context, retained signature/thumbprint checks, unsupported-target and substituted-package rejection, and the immutable native override path. Native acceptance additionally requires a real server with CA/CRL verification enabled, full-chain encrypted read/write and read-back, untrusted/revoked identities, and changed-leaf rejection. Dated results belong in ignored `tasks/`, not this guide.
