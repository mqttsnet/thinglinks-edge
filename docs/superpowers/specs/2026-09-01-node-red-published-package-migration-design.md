# Node-RED Published Package Migration Design

**Date:** 2026-09-01
**Status:** Proposed for implementation review
**Owner:** ThingLinks Edge
**Related package repository:** `mqttsnet/thinglinks-node-red`

## Context

ThingLinks Edge currently ships seven raw Node-RED files inside the Manager image, copies them into every instance under `/data/nodes`, and lets Node-RED load three types from that directory:

- `tl-device`
- `tl-tag`
- `tl-uplink`

The same implementation is now published as independently versioned npm packages:

- `@mqttsnet/thinglinks-edge-nodes@0.0.1`
- `@mqttsnet/thinglinks-node-red-common@0.0.1`

The Edge package is public, has been added to the Node-RED Flow Library, and has passed a real `nodered/node-red:5.0.4-24-minimal` installation and runtime matrix. The local Edge Manager npm proxy can resolve, cache, and serve both published tarballs.

The current Edge product path is not ready to consume the package without migration. The old raw files and the npm package register the same three node types. Node-RED can return HTTP 200 from `POST /nodes` while marking the npm node sets with `type_already_registered`, so install success alone is not proof that the npm implementation is running.

## Official discovery boundary

Three distinct discovery layers must remain explicit:

1. **npm registry:** authoritative source for package installation and version metadata.
2. **Node-RED Flow Library:** public community listing. The Edge package has been manually submitted and is searchable there.
3. **Node-RED Community catalogue:** the static catalogue used by Palette Manager. It updates independently from the Flow Library and may lag after a new submission.

The Edge console must not depend on Flow Library or Community catalogue refresh timing. Exact package lookup and fuzzy npm search are handled through configured npm sources. The local ThingLinks catalogue remains useful for approved, version-pinned, and offline packages.

## Goals

- Make exact and fuzzy Edge node searches return the published Edge package reliably.
- Make all newly created instances use the npm package instead of raw copied files.
- Provide an explicit, observable, rollback-safe migration for existing instances.
- Preserve current flows, credentials, ports, image tag, resource limits, and original running/stopped state.
- Make module inventory distinguish healthy npm loading from raw, builtin, conflicting, and failed node sets.
- Keep common as a normal transitive dependency: it is never approved, allow-listed, or displayed as a Node-RED module.
- Preserve offline installation by seeding the exact published Edge/common tarballs into the Manager package store.
- Prove installation, startup loading, Manager reporting, allowList removal, and recovery with the real Node-RED 5.0.4 image.

## Non-goals

- Do not publish another npm version as part of this migration.
- Do not submit common or Cloud packages to the Node-RED Flow Library.
- Do not migrate `line-1` before the isolated migration and rollback matrix is green.
- Do not delete legacy raw files during the first migration release.
- Do not classify every package under `@mqttsnet` as a ThingLinks platform package.
- Do not make Manager reporting failure a reason to roll back an otherwise healthy module load.

## Fixed package contract

The first migration release uses these immutable values:

```text
Edge package:      @mqttsnet/thinglinks-edge-nodes@0.0.1
Edge integrity:    sha512-NKsIKyUHNyB+xuXNpCrOqzEYbYflEFeXqC/IgjM2/+AzktSTb7+TZFBWHoqp9FjLDX2crpoah6gn8n+Uy32AkA==
Common package:    @mqttsnet/thinglinks-node-red-common@0.0.1
Common integrity:  sha512-T6QN9RlBF0qbvujaAKNY81BjrcIdbqeqFkLfQsGuKHI8UY2cgad9prF8xUC5n4BbHbNJ7ftBmSBkj+IEZvTJWQ==
Node-RED image:    nodered/node-red:5.0.4-24-minimal
Node types:        tl-device, tl-tag, tl-uplink
```

A dedicated `platform-package.ts` owns these constants. Callers do not duplicate package names, versions, integrities, or type lists.

## Selected approach

Use a staged compatibility migration:

```text
legacy raw active
  -> preflight
  -> npm package staged while raw remains active
  -> npm-mode settings exclude three raw runtime files
  -> one restart
  -> verify npm ownership and flow health
  -> commit runtime mode
```

Legacy files remain on disk as rollback assets. The migration does not rename or delete `/data/nodes`.

Node-RED 5.0.4 always scans `<userDir>/nodes`, so removing `settings.nodesDir` alone does not disable the old files. In npm mode, generated settings add these basenames to `nodesExcludes`:

```text
tl-device.js
tl-tag.js
tl-uplink.js
```

Node-RED applies these exclusions to raw files under `/data/nodes`; it does not apply the same basenames to files declared inside an npm package's `node-red.nodes` metadata. This suppresses raw registration while allowing the scoped package to load.

## Persistent instance model

Database migration v13 adds instance-level runtime state. Existing rows default to the current behavior.

```text
node_runtime_mode     legacy | npm             default legacy
platform_node_version text                     default empty
node_migration_state  idle | preparing | staged | cutover | verifying |
                      rolling_back | committed | rolled_back |
                      rolled_back_dirty | manual_required
node_migration_error  text                     default empty
```

Rules:

- Existing instances migrate to schema v13 as `legacy`.
- New instances are created as `npm`.
- `resetCredential`, `applyNodePolicy`, image upgrade, same-image rebuild, and restore all render settings from the persisted mode.
- Only a fully verified migration can set `node_runtime_mode=npm` and `node_migration_state=committed`.
- Failure keeps or restores `legacy`; a package cleanup failure results in `rolled_back_dirty`, not success.
- Manager startup detects non-terminal migration states and attempts rollback before accepting another operation for that instance.

## Instance operation gate

Migration, package installation, policy apply, credential reset, image upgrade, restore, and removal must share one per-instance operation gate.

While an instance is migrating:

- mutating Manager APIs for the same instance return a maintenance response;
- the Node-RED reverse proxy rejects editor writes and package changes while allowing read-only status;
- a second migration request returns the existing migration status instead of starting another transaction.

This prevents a concurrent settings rewrite from re-enabling raw nodes during cutover.

## Search design

### Exact lookup

If input is a syntactically valid npm module name, each configured source is queried directly for its packument before using fuzzy search.

- A package is returned only when its selected version has `node-red.nodes` and keyword `node-red`.
- `@mqttsnet/thinglinks-edge-nodes` returns immediately even when npm search indexing lags.
- `@mqttsnet/thinglinks-node-red-common` is rejected as a node result because it has no `node-red` metadata.
- The first configured source wins for duplicate package names.

### Fuzzy lookup

For non-exact input, query npm search with the user's plain text. Do not concatenate `keywords:node-red <query>` because the observed npm endpoint ignores the trailing user query in that form.

Filter returned objects locally:

- keyword list contains exact `node-red` case-insensitively;
- name, description, or keywords contain the user's normalized terms;
- results remain source-attributed and source-priority ordered;
- one failed source does not fail the whole search.

## Package seed and trust root

The Manager image no longer copies `packages/thinglinks-nodes` to `/app/nodes`.

Instead, the image build generates `/app/npm-seed` from the exact Edge package spec using the existing dependency-closure packer. The seed contains the original npm tarballs for Edge and common, not repacked `node_modules` directories.

Build gates verify:

- package name and version;
- SHA-512 integrity against the fixed contract;
- Edge declares exactly common `0.0.1`;
- Edge declares exactly three node types;
- common has no `node-red` field;
- no missing dependency closure.

`seedFromDir` remains generic and does not auto-approve arbitrary seed packages. A separate platform bootstrap approves only the exact Edge package/version constant because it is part of the signed ThingLinks product baseline. Common is seeded but never approved.

## New instance creation

New instances use npm mode from the start:

1. Persist the new instance row with `node_runtime_mode=npm`.
2. Generate settings with strict platform package exclusions and current palette policy.
3. Do not copy `/app/nodes` or create raw platform files.
4. Create and start the Node-RED container with Manager and private registry environment variables.
5. Wait for the Admin API to become ready.
6. Install exact Edge `0.0.1` through Node-RED `POST /nodes`, which resolves common through the Manager registry.
7. Verify module/version/types/enabled/error state and module path.
8. Only then return successful instance creation.

If readiness, installation, integrity, or module verification fails, creation compensation removes the DB row, container, network, and instance data directory. No half-created instance is returned.

## Existing instance migration transaction

### Preflight

Before touching runtime state:

- acquire the instance operation gate;
- require exact Edge approval `0.0.1`;
- require Edge/common tarballs in NodeStore and verify both integrities;
- verify Edge dependency closure and common's non-node boundary;
- verify the seven legacy files are exactly the known canonical files with canonical hashes and that `/data/nodes` contains no extra user files;
- record original running/stopped state;
- hash settings, flows, credentials, package manifest/lock, and current node inventory;
- verify container environment contains Manager URL, instance identity, ingest token, and private npm registry; if not, perform a same-image, same-data rebuild before staging;
- reject a conflicting third-party owner of any target type.

### Staging

With raw nodes still serving existing flows:

1. Install exact Edge `0.0.1` through Node-RED Admin API.
2. Require module and version to be present on disk with matching lock integrity.
3. Accept `type_already_registered` only for the three expected node sets during this staging phase.
4. Do not report the npm package as active yet.

### Cutover

1. Render npm-mode settings with the three legacy JS basenames added to `nodesExcludes`.
2. Write settings and restart once if the instance was originally running.
3. Wait for the Admin API and flows to become ready.
4. If the instance was originally stopped, write the settings without leaving it running; validate on an isolated data copy before committing the stopped instance migration.

### Verification

Migration succeeds only when all assertions pass:

- module is exactly `@mqttsnet/thinglinks-edge-nodes`;
- version is exactly `0.0.1`;
- exactly three node sets exist and are enabled with no non-empty error;
- the three types are owned only by the npm module;
- module path is `/data/node_modules/@mqttsnet/thinglinks-edge-nodes`;
- raw `node-red` entries no longer own any `tl-*` type;
- common can be required but does not appear in Node-RED inventory;
- flow and credentials hashes are unchanged;
- no unknown-node or duplicate-type startup errors exist;
- one real test flow calls common and all five Manager endpoints while preserving the original message;
- Manager reporting failure still warns and passes messages and does not invalidate a healthy module migration.

After verification, a single DB transaction writes npm mode, platform version, committed state, and the success audit record.

## Rollback

Rollback prioritizes restoring service:

1. Write legacy-mode settings without the three platform exclusions.
2. Restore the original running/stopped state.
3. Verify the raw three types are again owned by `/data/nodes` and existing flows are healthy.
4. Keep DB runtime mode as `legacy`.
5. Attempt to uninstall the staged npm package through the official Node-RED Admin API.

Outcomes:

- `rolled_back`: raw service restored and staged npm package removed cleanly.
- `rolled_back_dirty`: raw service restored but npm files or manifest entries remain.
- `manual_required`: raw service could not be restored; automation stops and provides exact recovery evidence.

The Manager never loops destructive retries automatically after `manual_required`.

## Inventory truth model

Node inventory preserves node-set evidence instead of flattening it away:

- module and version;
- types;
- enabled state;
- every non-empty error;
- module path when available;
- source: `builtin | raw | npm | mixed | unknown`;
- health: `healthy | conflict | failed`;
- compliance: `builtin | platform | approved | unapproved`.

Only the exact package `@mqttsnet/thinglinks-edge-nodes` is classified as a platform package. The whole `@mqttsnet` scope is not trusted because the organization publishes other products. Common never appears in inventory.

An install API response is successful only when the installed module is healthy. HTTP 200 with node-set errors is returned as failure with the original Node-RED evidence.

## HTTP and UI surface

Add explicit endpoints:

```text
GET  /api/instances/:id/nodes/thinglinks-migration
POST /api/instances/:id/nodes/thinglinks-migration
```

The POST requires instance operate permission and CSRF protection. It starts or returns the single migration transaction for that instance.

The Nodes page shows:

- Flow Library status separately from Community catalogue status;
- exact/fuzzy source results;
- platform package cached/approved/installed/active status;
- migration phase and last error;
- node source and module health;
- an explicit migration action with downtime and rollback warning.

No approval, search, or page refresh silently starts migration or restarts an instance.

## Test strategy

### Unit tests

- exact package lookup bypasses stale search indexes;
- common exact lookup is rejected as a node package;
- fuzzy search uses plain query text and locally filters `node-red` packages;
- runtime-mode persistence and settings rendering;
- npm-mode legacy exclusions do not exclude npm node sets;
- inventory retains errors and detects duplicate ownership;
- platform classification trusts only the exact Edge package;
- every migration stage and rollback outcome;
- a second migration call is idempotent and concurrent operations are blocked.

### Integration tests

- v13 migration defaults old rows to legacy and new rows can be npm;
- exact platform bootstrap approval does not approve arbitrary seeds;
- new-instance install failure compensates all resources;
- migration API permissions and CSRF;
- source failure isolation and source priority;
- package version/integrity and dependency closure gates.

### Real-container tests

Use `nodered/node-red:5.0.4-24-minimal` and the exact cached npm tarballs:

1. New instance starts without raw nodes and loads Edge/common through Manager registry while external network is unavailable.
2. Existing legacy data copy stages npm, cuts over, and preserves flows and credentials.
3. Failure after settings write rolls back to raw loading.
4. `allowList=[Edge]`, `denyList=["*"]` loads three types; common is absent from allowList and inventory.
5. Keeping the package installed but removing Edge from allowList makes all three types disappear after restart.
6. Restoring Edge to allowList makes all three types reappear and the flow execute again.
7. The real Manager receives the five Edge endpoints, derives instance from token, and ignores any body-level instance impersonation.

### Browser and external gates

- Flow Library detail and search pages contain the package.
- The official Community catalogue must contain the package before claiming Palette Manager official-directory discovery.
- ThingLinks catalogue shows approved Edge immediately and never shows common.
- Browser console and catalogue requests are error-free.

## Implementation slices

1. Search exact/fuzzy behavior and tests.
2. Platform package constants, seed integrity, and bootstrap approval.
3. Runtime mode schema/repository/settings and inventory truth model.
4. New instance npm-only creation.
5. Existing instance migration transaction and rollback.
6. HTTP/UI migration surface.
7. Real-container, offline, allowList, Manager, and browser acceptance.
8. Remove Manager raw copy from new images after all previous slices are green.

Each slice must leave existing legacy instances operational. `line-1` is migrated only after an isolated copy passes the full success and rollback matrix and the user authorizes the instance action.

## Files in scope

- `apps/manager/Dockerfile`
- `scripts/pack-nodes.sh`
- `apps/manager/src/index.ts`
- `apps/manager/src/core/db.ts`
- `apps/manager/src/core/instance/repo.ts`
- `apps/manager/src/core/instance/service.ts`
- `apps/manager/src/core/instance/docker-client.ts`
- `apps/manager/src/core/instance/settings-template.ts`
- `apps/manager/src/core/instance/container-spec.ts`
- `apps/manager/src/core/flows/admin-client.ts`
- `apps/manager/src/core/nodes/upstream.ts`
- `apps/manager/src/core/nodes/inventory.ts`
- `apps/manager/src/core/nodes/seed.ts`
- `apps/manager/src/http/nodes/catalog.ts`
- `apps/manager/src/http/instance/proxy.ts`
- `apps/web-console/src/api/client.ts`
- `apps/web-console/src/api/types.ts`
- `apps/web-console/src/views/nodes/NodesView.vue`
- focused tests beside each module
- a dedicated `apps/manager/scripts/verify-platform-nodes.mjs`
- offline bundle documentation and package manifest checks

## Release and claim boundaries

Completion is reported in layers:

- **Code complete:** unit/integration tests and static checks pass.
- **Artifact complete:** exact Edge/common seed tarballs and integrities are verified.
- **Container complete:** new-instance, migration, rollback, allowList, and Manager matrices pass.
- **Local Edge complete:** isolated Edge-managed instance passes UI and runtime acceptance.
- **Existing instance complete:** `line-1` migrates only after separate user authorization and post-migration verification.
- **Official discovery complete:** Flow Library and official Community catalogue both expose the package; one cannot substitute for the other.
