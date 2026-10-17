# Meridian Usage Platform

Assignment ID: `Fullstack-ClaudeGemini-UsageConnector-v1`

Meridian ingests Claude Enterprise and Google Cloud (Vertex AI Gemini) usage and cost exports, attributes them to groups and users through a trusted directory, and serves them through a server-rendered Admin UI and a four-tool MCP server. Capability controls (`usage-connector`, `web-search`, `code-execution`) are persisted per group. Every read and write is authorized server-side by one policy engine. Dev, staging and prod are provisioned deterministically from `starter-kit/environments/*.yaml`.

## Quick Start

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm check                            # format:check + lint + typecheck + test
pnpm validate:provisioning            # provisions dev/staging/prod in a temp root, twice

TS="node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register-ts.mjs"
$TS scripts/provision.ts staging      # dev | staging | prod -> generated/<env>/

MERIDIAN_ENV=staging $TS apps/admin/src/main.ts    # http://127.0.0.1:3100 (pnpm start:admin also works)
MERIDIAN_ENV=staging MERIDIAN_ACTOR_USER_ID=<user_id> $TS apps/mcp/src/main.ts
```

- `MERIDIAN_ENV` is mandatory for both servers. A missing or unknown value exits 1.
- `MERIDIAN_ACTOR_USER_ID` is the MCP caller identity. Valid ids are in `starter-kit/data/directory/users.json`.
- Admin options: `MERIDIAN_ADMIN_PORT` (default 3100), `MERIDIAN_DB_PATH`.
- Provision first. Both servers refuse to start against a missing database rather than creating an empty one.
- Provisioning also writes `generated/<env>/claude.mcp.json` and `gemini.settings.json`. Copy one to the repository root as `.mcp.json` (Claude) or `.gemini/settings.json` (Gemini) to register the server with a host.

## Architecture

```text
 vendor exports (Claude JSON, Gemini billing JSONL)      trusted directory + environment config
        ↓                                                         │
 ingestion · normalization · reconciliation                       │
        ↓                                                         │
 persistence (SQLite: observations, runs, capability state)       │
        ↓                                                         ↓
 ToolService ──────────────────────────────► central authorization (pure policy)
        ↓
 Admin UI (HTTP)   |   MCP server (stdio JSON-RPC)
```

- Claude (token + cost reports) and Gemini (per-SKU billing rows) keep separate observation types. They are combined only at the query layer, never forced into a false common record.
- Trusted identity is a configured user ID resolved against the directory. Role, scope and home group are never read from tool arguments, request bodies, or prompt text.
- Authorization sits beneath both clients in `ToolService`. The Admin UI renders every control and shows the server's denial; it contains no policy.
- Domain and authorization code import no HTTP, UI, database or MCP packages.
- SQLite (`better-sqlite3`, WAL) is an assignment-scale choice.
- MCP is newline-delimited JSON-RPC 2.0 over stdio. No HTTP API listener exists; `ToolService` is the application API.

## Data Integrity

- Every source artifact and row has a fingerprint. Raw source keys are stored as digests; raw excluded rows are not persisted.
- Same key and fingerprint is a **replay** (no new rows). Same key with a different fingerprint is a **restatement**: the prior row stays active and the new row is excluded and reported. Conflicting duplicates are excluded, never summed.
- Reconciliation compares raw source control totals to normalized totals. Unexplained deltas fail the run.
- Money is persisted as `bigint` in 1e-8 USD. Floats are not used for domain arithmetic.
- Only `complete` and `complete_with_exclusions` runs persist. `partial`, `failed` and `blocked` runs are refused with zero database writes.

```text
permission denied != no data       no data != zero usage
missing source    != deletion      replay  != restatement
```

A period with no rows returns `no_data`. A platform with usage but no cost rows returns `data_unavailable`, never zero.

## Authorization & Capability Controls

Roles, groups and scope grants come from the trusted directory and the environment YAML. Unknown users, environments, roles, scopes or conditions deny.

| Caller         | Environment  | Read own group | Read foreign group | Write own group | Write foreign group |
| -------------- | ------------ | -------------- | ------------------ | --------------- | ------------------- |
| member         | dev          | yes            | yes                | no              | no                  |
| member         | staging/prod | no             | no                 | no              | no                  |
| team lead      | dev          | yes            | yes                | yes             | no                  |
| team lead      | staging      | yes            | no                 | yes             | no                  |
| team lead      | prod         | yes            | no                 | no              | no                  |
| platform admin | all          | yes            | yes                | yes             | yes                 |

Dev is intentionally permissive per `dev.yaml`. Staging and prod apply production visibility rules; prod additionally restricts writes to platform admins. Capability defaults differ per environment (prod enables `usage-connector` only for `it-platform` and `clinical-operations`).

- Capability state is persisted. It is the only source of truth; the engine never reads defaults.
- A read requires `usage-connector` enabled for the **caller's home group**. Otherwise it is denied with `capability_disabled`. This gates `usage_summary`, `top_users` and `capability_status` (the starter-kit contract denies every tool in this case).
- `set_capability` is the control-plane recovery exception: it is exempt from the connector gate so a disabled connector can be re-enabled. It still needs the role, the `capabilities:write` scope and a permitted target group.
- Denials return a fixed `{error: "permission_denied", code, reason, required_scope?}` with no protected data. Foreign and unknown groups give identical denials to non-admins.

## MCP Tools

| Tool                                         | Scope                | Notes                                                |
| -------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `usage_summary(group?, period)`              | `usage:read`         | Per-platform tokens and cost plus totals             |
| `top_users(group?, period, limit?)`          | `usage:read`         | Ranked by `total_tokens`; `limit` 1-25, default 10   |
| `capability_status(group?)`                  | `usage:read`         | State of all three capabilities                      |
| `set_capability(group, capability, enabled)` | `capabilities:write` | Returns new state with `updated_at` and `updated_by` |

- `period` is **required** for `usage_summary` and `top_users`: `last_7_days`, `last_30_days`, ISO week (`2026-W36`) or month (`2026-09`). Relative periods anchor to the end of the data window, 2026-09-28 (exclusive).
- `group` defaults to the caller's home group where supported. `set_capability` requires it.
- Identity is never a tool argument. Unknown or extra arguments (including `user_id`, `role`, `scope`) are rejected as `invalid_input`.
- stdout carries JSON-RPC only. Startup diagnostics go to stderr.

## Provisioning & Environments

- `scripts/provision.ts <dev|staging|prod>` writes `generated/<env>/`: `meridian.sqlite`, `permissions.json`, `claude.mcp.json`, `gemini.settings.json`. `generated/` is git-ignored.
- Output is deterministic: re-running yields byte-identical config and no duplicate rows. Capability changes made with `set_capability` survive reprovisioning; defaults seed only missing rows.
- An unknown environment writes nothing and exits 1. Environment selection is always explicit; there is no default.
- Admin refuses to start in `prod`: it simulates the caller through a UI selector, and no authentication exists. MCP serves all three environments.
- The database path resolves against the repository root, so provisioning and servers work from any working directory.
- Validate with `pnpm validate:provisioning`.

## Testing & CI

`pnpm check` passes: **507 tests across 30 files**.

Coverage categories: normalization and reconciliation; persistence, exact money and privacy (including WAL contents); authorization including adversarial cases; API and tool contracts; real-process MCP; Admin behavior and lifecycle; provisioning; timezone behavior.

Real-process tests spawn the actual server and verify `initialize`, `tools/list`, an allowed tool call, a denied authorization, stdout/stderr separation, startup failures and signal shutdown.

There is no browser E2E framework. Admin behavior is covered by handler and real-process tests; `docs/demo-script.md` is the manual walkthrough.

CI (`.github/workflows/ci.yml`, Node 22): `pnpm check`, `TZ=America/Toronto pnpm test`, `TZ=Asia/Kolkata pnpm test`, `pnpm validate:provisioning`.

## Engineering Decisions

| Decision                                   | Reason                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Separate Claude and Gemini observations    | Sources differ (requests, cache tokens, per-SKU billing); merging hides gaps |
| `bigint` 1e-8 USD persistence              | Exact sums; no float drift across sources                                    |
| SQLite                                     | Zero-infrastructure, transactional, sufficient at assignment scale           |
| One authorization engine below all clients | UI and MCP cannot diverge; adversarial tests target one place                |
| Handwritten minimal MCP stdio server       | Four tools; no SDK dependency; protocol surface is small and fully tested    |
| No browser E2E framework                   | Handler and process tests cover behavior without adding a heavy dependency   |
| Deterministic provisioning                 | Reviewable, repeatable environments; CI verifies byte-identical reruns       |

## AI-Assisted Development

AI coding agents were used for planning, implementation, adversarial review and regression generation, one reviewed task at a time (`docs/tasks/`). Output was checked against the starter-kit contract and invariants rather than accepted as written. Review caught or overruled:

- A migration running before the zero-write refusal for non-persistable runs.
- An unnecessary TypeScript downgrade.
- Drizzle being a dependency without meaningful use.
- A WAL/privacy coverage gap.
- `period` treated as optional; the contract requires it.
- MCP argument validation ordering that could leak validity to denied callers.
- `arguments: null` handling.
- An Admin recovery gap when `usage-connector` is disabled.
- Admin creating an empty database for a missing path.

## Production Evolution

Not implemented; these are the next steps beyond assignment scope.

- Managed PostgreSQL with formal migrations.
- OIDC/workload identity in place of a configured user ID.
- Centralized audit logging of reads and capability changes.
- Metrics and tracing.
- Highly available deployment.
- Retry, backoff and rate limiting against real vendor APIs.
