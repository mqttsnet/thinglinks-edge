# ThingLinks Edge — AI Working Agreement

This file is the repository-wide source of truth for coding agents.

## Start here

- Run `git status --short --branch` before editing. Preserve unrelated, staged, and untracked work.
- Read the source file, its tests, and one nearby pattern before changing behavior.
- Start with `docs/README.md` for shared documentation; read only the documents relevant to the task.
- Keep task-specific plans, drafts, and verification reports under ignored `tasks/`, outside the shared docs. Read a local plan only when the task explicitly references it.
- Treat repository documentation as design context, not proof that code or runtime behavior exists.

## Project shape

- Supported Node.js versions are `^22.18.0` and `^24.12.0`; the Manager image uses Node 24. TypeScript 5.9 runs in a pnpm workspace.
- `apps/manager`: Fastify, better-sqlite3, Dockerode, Node-RED instance orchestration.
- `apps/web-console`: Vue, Vite, TypeScript.
- `packages/thinglinks-nodes`: bundled ThingLinks Node-RED nodes.
- Manager TypeScript source intentionally uses explicit `.ts` relative imports. Do not rewrite them to `.js`; the build rewrites emitted imports.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Lint: `pnpm lint`
- Type check: `pnpm typecheck`
- Unit tests: `pnpm test`
- Production build: `pnpm build`
- Source repository gate: `pnpm check`
- Full Manager/container gate: `cd apps/manager && pnpm verify`

Use the narrowest relevant test while iterating, then run the proportional repository gate before claiming completion.

## Change discipline

- Use tests first for behavior changes and bug fixes.
- Keep changes task-scoped. Do not refactor adjacent code without a task reason.
- Preserve existing public contracts and failure semantics unless the task explicitly changes them.
- Do not commit, push, rewrite history, or alter commit metadata unless the user explicitly asks.
- When committing a dirty worktree, stage only task-owned files.

## Runtime and data safety

- Never print, commit, or copy secrets from `.env`, databases, settings files, cookies, or tokens.
- Do not delete or recreate containers, networks, volumes, databases, or instance data without explicit scope and read-only inventory first.
- `line-1` and other existing instances require explicit authorization before restart, migration, reset, or destructive verification.
- Keep browser-facing catalogue URLs distinct from container-internal npm registry URLs.
- Changes to Node-RED installation, allowlist, offline, proxy, or instance lifecycle behavior require focused real-container verification.

## Evidence and completion claims

Keep these claims separate:

1. source present;
2. focused tests passed;
3. full build/typecheck passed;
4. isolated real-container verification passed;
5. browser behavior verified;
6. existing instance verified;
7. external service or catalogue verified;
8. release accepted.

One layer never proves another. Report skipped or unavailable gates explicitly.

## Documentation

- `docs/` contains reusable product, deployment, operation, and architecture documentation.
- Put documentation images in `docs/images/`: `brand/`, `screenshots/`, `architecture/`, and editable `sources/`.
- Keep reusable configuration and capability boundaries in shared docs; keep dated test results, local paths, and execution checklists in ignored `tasks/`.
- A plan or checked box is not runtime evidence.
- Keep links relative and update every reference when moving a document or image.
