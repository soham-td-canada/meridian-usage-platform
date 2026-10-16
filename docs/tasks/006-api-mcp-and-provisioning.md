# 006 — API, MCP and Provisioning

## Goal

Expose the four contract tools through a thin MCP stdio server over a transport-neutral application service, and render deterministic per-environment provisioning (database, permission manifest, Claude and Gemini MCP registration).

Sources: `starter-kit/README.md`, `starter-kit/contracts/tools.schema.json`, `starter-kit/environments/*.yaml` (read-only), Tasks 002–005.

## Affected invariants

- Every tool call passes `resolveActor` + `authorizeRead` / `authorizeCapabilityWrite` (Task 005). No policy in transport or service code.
- Identity is server-side only: the MCP process reads `MERIDIAN_ACTOR_USER_ID` from its launch environment. No tool argument, header or prompt text carries identity, role, scope or home group.
- Denials stay structured (`Denial`, with `code`) and carry no protected data. Unknown/missing state denies.
- Money stays exact (`bigint` e-8 USD) until the final JSON number conversion by decimal string (no float arithmetic).
- Periods are `[start, end_exclusive)` UTC days. Missing data is an explicit error, never zero.
- Steps 2–5 behavior is unchanged; Task 005's `set_capability` control-plane exemption is preserved.

## Layout and boundaries

| Path                                         | Role                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/persistence/src/usage-queries.ts`  | Read-only aggregates over Step 4 tables (additive; exported from index)                                                                     |
| `apps/api/src/period.ts`                     | Period parsing/resolution                                                                                                                   |
| `apps/api/src/tool-service.ts`               | `createToolService(ctx).invoke(trustedUserId, tool, args)` — the application layer                                                          |
| `apps/api/src/bootstrap.ts`                  | Directory loading + database provisioning (idempotent)                                                                                      |
| `apps/mcp/src/tools.ts`, `server.ts`         | Tool listing (JSON Schema) and JSON-RPC 2.0 / MCP stdio handling; delegates to service                                                      |
| `apps/mcp/src/main.ts`                       | Reads trusted env (`MERIDIAN_ENV`, `MERIDIAN_ACTOR_USER_ID`, `MERIDIAN_DB_PATH`), serves                                                    |
| `apps/mcp/src/provisioning.ts`               | Pure rendering of manifest + Claude/Gemini registration                                                                                     |
| `scripts/provision.ts`                       | CLI: `provision <dev\|staging\|prod>`                                                                                                       |
| `scripts/ts-resolver.mjs`, `register-ts.mjs` | Maps `.js` import specifiers to `.ts`; with `--experimental-transform-types` Node 22 runs the TS sources (Step 3 uses a parameter property) |

No Fastify and no MCP SDK are installed and dependencies may not change, so: the "API" is the application service (no HTTP listener), and the MCP server implements the minimal MCP stdio subset by hand (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; newline-delimited JSON-RPC 2.0; stdout carries protocol only).

## Service contract

`invoke(trustedUserId: string, tool: string, args: unknown): ToolOutcome`

```ts
type ToolOutcome =
  | { kind: 'ok'; value: JsonValue }
  | { kind: 'denied'; denial: Denial } // Task 005 shape, unchanged
  | { kind: 'error'; error: ToolError };
type ToolError = {
  error: 'unknown_tool' | 'invalid_input' | 'no_data' | 'data_unavailable';
  message: string; // fixed string, never echoes input
};
```

Order of operations (fixed): tool name known → `args` is a plain object with only known keys (else `invalid_input`) → `resolveActor` → capability snapshot (`listCapabilityState`; failure ⇒ `unavailable`) → authorize (group is passed through as `unknown`; the engine validates it) → validate remaining args → execute. A denied caller therefore never learns whether other arguments were valid.

## Tool contracts

Group is `GroupId` (contract enum); omitted ⇒ caller home group (engine decision `allow.group` is the only group used).

| Tool                                         | Auth                                           | Result                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage_summary(group?, period)`              | `authorizeRead`                                | `{group, period:{start,end_exclusive}, platforms:[{platform,requests,input_tokens,output_tokens,total_tokens,cost_usd}], totals:{total_tokens,cost_usd}}`; platforms ordered claude, gemini; a platform with no rows in the period is omitted |
| `top_users(group?, period, limit?)`          | `authorizeRead`                                | array of `{user_id,name,email?,group,total_tokens,cost_usd}` ranked by `total_tokens` desc, tie `user_id` asc                                                                                                                                 |
| `capability_status(group?)`                  | `authorizeRead`                                | array of `{group,capability,enabled,updated_at,updated_by}` in `CAPABILITIES` order; all three must exist else `data_unavailable`                                                                                                             |
| `set_capability(group, capability, enabled)` | `authorizeCapabilityWrite` (no connector gate) | `{group,capability,enabled,updated_at,updated_by}` from `setCapabilityState` (`updated_by` = trusted actor id, `updated_at` = server clock ISO); same-value set writes nothing                                                                |

Decision flagged: the task shorthand writes `period?`, but the supplied contract (`tools.schema.json`, README) requires `period` for `usage_summary` and `top_users`. The contract wins (it is read-only and must not be altered): `period` is required, a missing `period` is `invalid_input`, and there is no default. Published `inputSchema` mirrors the contract and sets `additionalProperties: false`.

## Validation

- `period` (required): string, one of `last_7_days`, `last_30_days`, ISO week `YYYY-Www` (week must exist in that ISO year), month `YYYY-MM` (01–12). Anything else ⇒ `invalid_input`.
- `limit`: integer 1–25 (default 10); strings, floats, `null`, booleans rejected.
- `capability`: exact member of `CAPABILITIES`. `enabled`: strict boolean. `group` for `set_capability` is required (engine treats omitted as malformed).
- Unknown argument keys (including `role`, `scope`, `user_id`, `home_group`) ⇒ `invalid_input`; they are never read.

## Period semantics

Relative periods anchor to the end of the data window: `end_exclusive = 2026-09-28` (README). `last_7_days = [2026-09-21, 2026-09-28)`, `last_30_days = [2026-08-29, 2026-09-28)`. ISO week = Monday..next Monday. Month = first day..first day of next month. Queries use `period_day >= start AND period_day < end_exclusive` over `usage_observations` / `charge_observations` (day = UTC day key).

## Missing data

- No ingestion run persisted ⇒ `data_unavailable`.
- No usage rows for the group in the period ⇒ `no_data` (not zeros).
- A platform with usage rows but no charge rows (or the reverse) ⇒ `data_unavailable` (cost never defaults to zero).
- Aggregates beyond `Number.MAX_SAFE_INTEGER` ⇒ `data_unavailable`.

## MCP mapping

- `ok` ⇒ `result.content[0].text` = JSON, `structuredContent` for object results only, `isError:false`.
- `denied` ⇒ `isError:true`, text = the `Denial` JSON verbatim (`error`, `code`, `reason`, `required_scope?`), plus `structuredContent`.
- `error` ⇒ `isError:true`, text = the `ToolError` JSON.
- Unknown tool name / malformed JSON-RPC ⇒ JSON-RPC error (`-32602` / `-32600` / `-32700` / `-32601`).
- `initialize` ⇒ `{protocolVersion, capabilities:{tools:{}}, serverInfo:{name:<server_name>, version}}`; `protocolVersion` echoes the client's when it is a supported version (`2025-06-18`, `2025-03-26`, `2024-11-05`), else `2025-06-18`. Notifications (no `id`) never get a response. `ping` ⇒ `{}`.
- Exactly four tools are listed: `usage_summary`, `top_users`, `capability_status`, `set_capability`.
- Missing/unresolvable `MERIDIAN_ACTOR_USER_ID` ⇒ every call returns `identity_unresolved`; unknown `MERIDIAN_ENV` ⇒ server refuses to start.

## Provisioning

`provision <env>` (`dev` | `staging` | `prod`; anything else exits non-zero and writes nothing) produces under `generated/<env>/` (git-ignored):

- `meridian.sqlite`: migrations + ingestion of the starter-kit artifacts via `ingestAndPersist`, which seeds capability defaults only for missing rows. Re-running adds no usage/charge/capability rows and preserves capability changes made via `set_capability`.
- `permissions.json`: scopes, role grants, group visibility and capability defaults rendered from the Task 005 policy table and Task 4 config defaults (not re-typed).
- `claude.mcp.json`: `{ mcpServers: { <server_name>: { type: 'stdio', command, args, env } } }`.
- `gemini.settings.json`: `{ mcpServers: { <server_name>: { command, args, env, trust: false } } }`.

Server names follow the YAML `host.server_name`: `meridian-usage-dev`, `meridian-usage-staging`, `meridian-usage`. `env` sets `MERIDIAN_ENV`, `MERIDIAN_DB_PATH` (repo-relative) and passes `MERIDIAN_ACTOR_USER_ID` through from the host environment (`${…}` for Claude, `$…` for Gemini). Registration files contain no timestamps, absolute paths or secrets and are byte-identical on re-run. Command: `node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register-ts.mjs apps/mcp/src/main.ts`. Supported launch mechanism: the files are project-scope registrations (`.mcp.json` for Claude, `.gemini/settings.json` for Gemini) placed at the repository root, so hosts launch the child with the repository root as working directory. The database path is independent of the working directory: `main.ts` resolves a relative `MERIDIAN_DB_PATH` against the repository root derived from `import.meta.url`.

## MUST-HAVE tests

1. Persistence queries: exact sums vs independent fixture computation; `[start,end)` boundaries; group isolation; empty ⇒ nothing, not zero.
2. Period resolution: all four forms, boundaries, invalid weeks/months/strings; month/week edges.
3. Each of the four tools: happy path (admin, lead, member where allowed), default group, explicit group, contract output shape.
4. Authorization: every tool × denial code (scope, foreign group, unknown group identical, connector disabled, state unavailable, unknown env, unknown user); `set_capability` allowed while connector disabled; no data in any denial.
5. Adversarial: role/scope/user_id/home_group arguments rejected and never alter outcome; prompt-like strings in `group`/`period`.
6. Validation: period, limit (0, 26, 1.5, "5", null), capability, enabled ("true", 1), non-object args, unknown keys; no persistence write on invalid `set_capability`.
7. Capability write/read: persisted state round-trip, `updated_by` is the trusted actor, same-value idempotent, `capability_status` reflects the write.
8. Missing data: empty database, period with no rows ⇒ structured error not zeros.
9. MCP: transcript tests for `initialize` (result shape, version negotiation), `notifications/initialized` (no response), `ping`, `tools/list`; `tools/list` is exactly four names and matches contract schema (enums, limit bounds, `additionalProperties:false`); denial returned as structured `isError` result with the Denial JSON; unknown tool ⇒ JSON-RPC error; malformed JSON; identity cannot be supplied via arguments.
10. Provisioning: three envs render; unknown env fails closed; idempotent re-run; Claude/Gemini files byte-identical across runs; the rendered registration launches a working server from the repo root, and the database resolves correctly when `main.ts` is launched from another working directory; permissions manifest matches `starter-kit/environments/*.yaml`; server names match YAML; capability defaults seeded per env; capability change survives re-provision.

## Out of scope

HTTP/Fastify listener, MCP SDK, authentication/sessions, OAuth, audit logging, rate limiting, UI/admin app, hosted deployment, coverage/partial-period annotations, changes to Steps 2–5 semantics or specs, new dependencies, Step 7.
