# AI development documents

`docs/superpowers` contains shared, task-specific context for humans and coding agents. It is not loaded automatically by itself; repository instruction files route agents here when a task references a documented topic.

## Read order

1. Read the matching spec to understand intent and constraints.
2. Read the matching plan only when implementing that topic.
3. Verify current source, git state, and runtime evidence before acting on document claims.

Do not load unrelated specs or plans into the same task.

## Directory roles

- `specs/`: stable design intent, scope, non-goals, contracts, and acceptance criteria.
- `plans/`: ordered implementation tasks, dependencies, files, commands, and pass criteria.

Specs and plans are planning artifacts. Their existence, status, or checked boxes do not prove implementation, runtime behavior, external availability, or release acceptance.

## Minimal document rules

- Use `vX.Y.Z-<topic>-design.md` for specs and `vX.Y.Z-<topic>.md` for plans.
- Put the target product version inside each document as `Target version: X.Y.Z`; keep dates as `Created` or `Updated` metadata only.
- A plan must link its spec with a relative Markdown link.
- A spec should link its active plan when one exists.
- Keep task IDs unique and dependency order explicit.
- Put each non-obvious constant or contract in one authoritative place and reference it elsewhere.
- Separate source, focused-test, build, container, browser, existing-instance, external-service, and release evidence.
- Preserve superseded decisions through links instead of silently rewriting history.

## Current topics

| Version | Topic | Spec | Plan | Current meaning |
|---|---|---|---|---|
| 1.0.2 | Node-RED published package migration | [Design](specs/v1.0.2-node-red-published-package-migration-design.md) | [Implementation plan](plans/v1.0.2-node-red-published-package-migration.md) | Planning context only; not implementation or verification proof |
