# Task 8 — journaled running-instance platform migration

## Status

Complete from base `acb513e`.  The implementation is intentionally limited to
running legacy instances.  It does not change line-1, start stopped-instance or
same-image-repair work (Task 9), start Docker, publish a package, or push.

## Delivered behavior

- `MigrationCheckpointStore` persists the complete settings/flow/package and
  Node-RED bookkeeping file set under
  `<instanceDataRoot>/.thinglinks-migration/<instance>/<tx>`, not the bind
  mount.  It uses a 0700 partial/ready tree, metadata-only manifest, regular
  file and symlink checks, per-file fsync, directory fsync, and atomic ready
  rename.  Traversal and untrusted roots/manifest/files are rejected.
- Every journal phase is persisted before its next runtime effect and awaited
  through the operation barrier.  The outer migration lease drains proxy
  sessions before the snapshot; the migration-only renderer reuses that lease
  without recursion.
- Preflight is fail-closed: legacy source file hashes/set, package trust,
  immutable running container identity, normalized Manager URL, exact registry,
  exact instance id, timing-safe ingest-token digest, Admin raw-node ownership,
  staged package identity, dependency closure, and disk integrity are checked
  before cutover.  It keeps secrets out of snapshots, projections, errors, and
  controlled audit payloads.
- Exact pre-staged Edge/common versions with expected duplicate evidence skip
  installation.  Any partial, version, integrity, ownership, or environment
  drift rejects before cutover.  Fresh staging accepts only the three expected
  duplicate type results and validates filesystem evidence.
- Cutover writes npm exclusions, restarts the original running container, and
  verifies Admin owners/health, host package files, flow/credential hashes, and
  existing-flow health before the atomic `verifying -> committed` repository
  transaction.
- Rollback uninstalls only package state installed by this transaction before
  restoring checkpoint bytes, mode and original running state.  It preserves
  already staged packages; cleanup-only failure is `rolled_back_dirty`, while
  untrusted checkpoint or failed legacy recovery becomes `manual_required`.
  Clean terminals remove a verified checkpoint; retryable cleanup failures add
  only the controlled `checkpoint_cleanup_pending` audit and startup retries
  cleanup idempotently.  SQLite journal replacement covers first-run and
  clean-rollback retry races.

## Tests added or extended

- `migration-checkpoint.test.ts`: atomic checkpoint metadata/perms, preparing
  cleanup/traversal, byte/mode/existence restore, terminal retention, and
  symlink trust boundaries.
- `platform-migration.test.ts`: drift/secret barriers, ordering and proxy drain,
  running success, pre-staged path, invalid staging, each cutover/verification
  rollback boundary, dirty/manual outcomes, cleanup retry, and two-connection
  SQLite races.
- Existing Docker, repository, and service test files cover the migration
  inspection, controlled cleanup audit, and under-lease settings rendering.

## Fresh authoritative verification

Executed after takeover and final lint correction:

```text
node --experimental-strip-types --test \
  apps/manager/src/core/nodes/migration-checkpoint.test.ts \
  apps/manager/src/core/nodes/platform-migration.test.ts \
  apps/manager/src/core/instance/docker-client.test.ts \
  apps/manager/src/core/instance/repo.test.ts \
  apps/manager/src/core/instance/service.test.ts
# PASS: 111/111

pnpm lint
# PASS

pnpm --filter @thinglinks-edge/manager typecheck
# PASS

pnpm --filter @thinglinks-edge/manager test
# exit 0; 852 passed, 3 expected skips, 0 failed (159.478 s)

git diff --check
# PASS
```

The Manager-only `lint` script is an informational redirect to root lint;
root `pnpm lint` was therefore the effective lint gate.

## Recovered prior-agent evidence (not authoritative)

Before takeover, the interrupted agent reported checkpoint 4/4, preflight/order
5/5, running success 2/2, rollback/race 13/13, affected matrix 111/111, and
Manager typecheck green.  It did not provide a completed full-suite exit/TAP
result.  The fresh checks above replace those claims.

## RED evidence and correction

The first fresh root lint run was RED with two preserved-diff style failures:
an unused initial `cleaned` assignment and a `let` that was never reassigned.
No product behavior was changed: the retry checkpoint branch now returns
directly when ready, and the test fixture binding is `const`.  The refreshed
affected matrix, root lint, typecheck, and final full suite are green.

## Self-review and remaining boundaries

Reviewed the diff for checkpoint path containment, symlinks, 0700/0600 modes,
fsync and atomic rename; redaction/closed error codes; phase/barrier sequencing;
lease/drain ordering; exact identity and package ownership; no flow mutation;
rollback ordering, immutable-image check, original running state; terminal
checkpoint retention/cleanup; and cross-connection journal races.  No task
scope violations found.  This is source and test evidence only: no real Docker
runtime, device/browser, npm publication, or release acceptance was run.

## Fix round 1

Addressed C21--C24 and the checkpoint review findings in a separate follow-up
commit.  Read-only preflight now happens before the operation lease drains any
editor sessions, then all mutable facts are revalidated after drain and before
the journal.  The exact `sha256:` 64-hex immutable image form is required.

Checkpoint source and verification reads now use no-follow descriptors with
regular-file/stable pre/post `fstat` checks.  The final file/manifest mode is
applied before fsync; the manifest must be exactly 0600.  The ready manifest is
compared with the revalidated persistent snapshot facts before install.

Fresh install ownership is durable before `POST /nodes`, so an install that
mutates then throws is cleaned.  Newly-owned cleanup checks Admin and disk
footprints after uninstall; residuals become `rolled_back_dirty`.  Interrupted
Task 8 journals recover through the exact durable row without trying to
reacquire the ordinary blocked gate.  Flow identity is captured in-memory at
preflight and compared after cutover; rollback verifies restored bytes again
after Node-RED restart.

RED captured before these fixes: invalid preflight disconnected a registered
editor, between-pass mutation had only one inspection, image tags were
accepted, and mutation-then-throw left a package unowned.  A later focused run
also caught a helper/parameter shadowing regression, which was corrected before
final verification.

Fresh fix-round checks before the full-suite gate: affected Task 8 plus
repo/docker/service tests 120/120; root `pnpm lint` PASS; Manager typecheck
PASS; `git diff --check` PASS.  The full Manager-suite result is recorded with
the follow-up commit handoff.

## Fix round 2

Added a checkpoint closing pass that reopens every allowlisted live source and
compares existence, mode, size, and hash to the finished manifest before the
partial tree is published.  Drift removes the partial checkpoint.

Added `instance_id + tx_id + expected phase` repository CAS transitions for
Task 8 phase advancement.  The internal `platform-recovery` gate operation is
available only to consistent recoverable migration journals; terminal, dirty,
manual, pending, and idle states remain fenced.  Public rollback and startup
recovery now acquire that recovery lease and re-read the exact tx before using
the phase-aware recovery path, while an active platform migration retains its
exclusive in-memory lease.

Fresh round-2 focused verification: `platform-migration.test.ts` plus
`operation-gate.test.ts` PASS (40/40); Manager typecheck PASS; root lint PASS;
`git diff --check` PASS.  Full Manager suite was not rerun in this interrupted
round before handoff; do not treat this section as full-suite evidence.

Round-2 final Manager suite: exit 0; 862 passed, 3 expected skips, 0 failed
(168.089 s).  Repository CAS coverage was added and focused repository/gate
checks passed before the final suite.

## Fix round 2 completion

Commit `4f1a4b4` is the preserved partial round-2 commit.  It introduced the
checkpoint closing pass, the internal recovery lease, phase-transition CAS
primitives, and the first recovery refactor.  It did not contain the handed-off
C26 discriminating tests and did not finish exact terminal CAS, replacement-tx
recovery safety, common-only residual proof, or checkpoint-backed flow identity.

This completion is the separate follow-up commit named
`fix(nodes): 补齐迁移恢复竞态与残留验证`; it does not amend `4f1a4b4`.  It adds:

- a durable recovery-policy matrix: only consistent Task-8 migration journals
  in `preparing`, `checkpointed`, `staged`, `cutover`, `verifying`, or
  `rolling_back` can acquire `platform-recovery`; idle, bootstrap, committed,
  rolled-back, dirty, manual, pending, and inconsistent-error states cannot;
- exact `instance_id + tx_id + expected phase` atomic commit, rollback terminal,
  and manual terminal repository operations, including their audit writes;
- immutable-journal recovery: rollback receives the caller-observed journal,
  CAS-claims that exact tx before runtime effects, stops when ownership is lost,
  and never finalizes a replacement tx; repeated exact recovery is idempotent;
- public rollback through the recovery lease, with active migration reported
  busy and `preparing` without a ready checkpoint finalized cleanly through the
  same phase-aware recovery path as startup;
- residual detection for either platform package in root package/lock data and
  for either package directory, so common-only leftovers are
  `rolled_back_dirty`; `stagedBefore=true` proves Edge/common root, lock, and
  package-directory bytes are preserved and never uninstalled;
- flow-ID comparison derived from the restored/live `flows.json`, not from a
  pre-restart Admin response.  Restored nonempty flows with empty or unrelated
  post-readiness Admin IDs become `manual_required`; exact IDs and legitimate
  empty-file/empty-Admin state pass.

The inherited C26 test now deterministically covers an earlier captured file
changing, an absent file appearing, and a present file disappearing.  All three
reject without publishing either ready or partial state.  Its deterministic
seam is a protected fixed-boundary no-op overridden only by the test subclass:
production construction keeps the original single-argument API, there is no
HTTP/environment switch or injectable filesystem implementation, and the seam
cannot bypass closing-pass comparison or ready publication ordering.

### Fresh RED evidence

The missing completion behavior was tested before its production fixes:

```text
operation-gate.test.ts
# RED: 16/17; platform-recovery incorrectly accepted clean idle

repo.test.ts
# RED: 32/33; exact commit/rollback/manual finalizer APIs did not exist

platform-migration.test.ts
# RED: 25/29
# - restored nonempty flows with empty Admin ended rolled_back, not manual_required
# - common-only root dependency residual ended rolled_back, not rolled_back_dirty
# - public preparing/no-ready rollback ended manual_required, not rolled_back
# - stale scan finalized the replacement tx as manual_required
```

The C26 production closing pass already existed in `4f1a4b4` before the
preserved tests were handed over, so its first fresh execution was correctly
recorded as inherited GREEN (6/6), not fabricated as a new RED claim.

### Fresh GREEN and full-suite evidence

All commands below ran after the final production and test changes:

```text
node --experimental-strip-types --test \
  apps/manager/src/core/nodes/migration-checkpoint.test.ts \
  apps/manager/src/core/nodes/platform-migration.test.ts \
  apps/manager/src/core/instance/operation-gate.test.ts \
  apps/manager/src/core/instance/repo.test.ts \
  apps/manager/src/core/instance/docker-client.test.ts \
  apps/manager/src/core/instance/service.test.ts
# PASS: 144/144

pnpm --filter @thinglinks-edge/manager typecheck
# PASS

pnpm lint
# PASS

git diff --check
# PASS

pnpm --filter @thinglinks-edge/manager test
# exit 0; 873 tests, 870 passed, 3 expected skips, 0 failed
# duration: 163.899 s
```

Self-review rechecked the Task-8-only call graph for generic journal updates,
terminal writes, replacement-tx rereads, side effects before exact claim,
recovery-policy fallthrough, uninstall ownership, common closure residuals,
checkpoint publication, and flow-ID source.  No generic Task-8 transition or
finalizer remains.  Scope remains source and test evidence only: no Task-9
wiring, stopped-instance repair, environment repair, synthetic flow, Docker
runtime, line-1 mutation, package publication, push, or release acceptance was
performed.
