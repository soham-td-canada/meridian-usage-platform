# 001 — Repository Foundation

## Goal

Establish deterministic TypeScript engineering guardrails before
application implementation begins.

## Invariants

- No `any`.
- Strict TypeScript remains enabled.
- Unsafe TypeScript fails linting.
- Supplied starter-kit files remain unchanged.
- Formatting does not alter starter-kit contents.
- Tests run successfully.
- Workspaces have explicit ownership boundaries.

## Out of scope

- Canonical usage model.
- Vendor mapping.
- Database.
- Fastify.
- React.
- MCP.
- Provisioning logic.

## Acceptance

The following commands must succeed:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```
