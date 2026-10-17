# Task 7.5 — Operational hardening

## Inspected

`apps/admin/src/main.ts`, `apps/mcp/src/main.ts`, `apps/mcp/test/*`, `apps/admin/test/*`, provisioning scripts, Tasks 005–007.

## Already covered (unchanged)

- MCP real-process boundary via `spawnSync` (initialize, one `tools/call`, no-actor denial, working-directory independence, unknown env / empty env / missing DB refusal) in `apps/mcp/test/provisioning.test.ts`.
- MCP closes its database on stdin close; unknown/empty `MERIDIAN_ENV` and a missing DB already fail with exit 1 and no stdout.
- Admin refuses `prod` and invalid `MERIDIAN_ENV`.
- Protocol/authorization behavior and the four-tool contract (in-process tests).

## Gaps found and changed

- Admin opened a missing database path, silently creating an empty SQLite file. It now exits 1 with the same message as MCP.
- Admin had no SIGINT/SIGTERM handling. It now stops listening, closes idle connections, closes the database once, and exits naturally.
- MCP had no signal handling. SIGINT/SIGTERM now close the reader, which runs the single `close` handler (DB closed once).
- No test covered `tools/list`, structural denial of `set_capability`, unknown-actor denial, stdout purity / empty stderr on success, stderr-only diagnostics on startup failure, or signal shutdown over a real process. Added `apps/mcp/test/process.test.ts` and `apps/admin/test/process.test.ts`.

## Intentionally not added

- `pnpm smoke`: the process tests plus `validate:provisioning` already give it; a second command would duplicate them.
- Trusted-directory load failure process test: needs a corrupt starter kit, which must not be modified.
- Health endpoints, structured logging, request-drain timeouts.
- Admin no longer defaults `MERIDIAN_ENV`: environment selection is explicit, missing or invalid values fail closed, and development mode must be intentionally requested.
