# ThingLinks Edge repository instructions

- Follow `AGENTS.md` as the canonical repository working agreement.
- Supported Node.js versions are `^22.18.0` and `^24.12.0`; use pnpm 10.
- Inspect `git status --short --branch` and preserve unrelated work before editing.
- Run focused tests while iterating. Use `pnpm check` for the source gate, `pnpm build` for production output, and `cd apps/manager && pnpm verify` for the full Manager/container gate.
- Keep changes task-scoped and do not change public contracts, runtime data, or container state without explicit scope.
- Never expose secrets from `.env`, databases, settings, cookies, or tokens.
- Read `docs/superpowers/README.md` and the linked topic spec/plan when a task references them.
- Distinguish source, test, container, browser, existing-instance, external-service, and release evidence.
- Do not treat documentation or a successful install as proof of runtime loading or release acceptance.
