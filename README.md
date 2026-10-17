# Meridian Usage Platform

Assignment ID: `Fullstack-ClaudeGemini-UsageConnector-v1`

Meridian ingests Claude Enterprise and Google Cloud (Vertex AI Gemini) usage and cost exports, attributes them to users and groups through a trusted directory, and reports usage and cost by platform, group and week. Capability controls (`usage-connector`, `web-search`, `code-execution`) are persisted per group. One policy engine authorizes every read and write. The same service is exposed through a server-rendered Admin UI, a Fastify HTTP API and a four-tool MCP server. Dev, staging and prod are provisioned deterministically from `starter-kit/environments/*.yaml`, including Claude plugin and Gemini CLI extension packages.

## Quick Start

Requires Node >= 22 and pnpm 12.11.2 (pinned in `package.json`).

```bash
pnpm install
pnpm check                      # format:check + lint + typecheck + test
pnpm provision staging          # dev | staging | prod -> generated/<env>/
pnpm validate:provisioning      # provisions all three environments twice in a temp root

MERIDIAN_ENV=staging pnpm start:admin                                  # http://127.0.0.1:3100
MERIDIAN_ENV=staging pnpm start:api                                    # http://127.0.0.1:3200
MERIDIAN_ENV=staging MERIDIAN_ACTOR_USER_ID=<user_id> pnpm start:mcp   # stdio JSON-RPC
pnpm test:e2e                                                          # Playwright (first: pnpm exec playwright install chromium)
```

- `MERIDIAN_ENV` (`dev`, `staging`, `prod`) is mandatory for every server; a missing or unknown value exits 1. Admin requires it explicitly and refuses `prod`; the HTTP API and MCP support all three.
- `MERIDIAN_ACTOR_USER_ID` is the MCP caller (ids: `starter-kit/data/directory/users.json`).
- Ports: `MERIDIAN_ADMIN_PORT` (default 3100), `MERIDIAN_API_PORT` (default 3200), bound to 127.0.0.1.
- Provision first. Servers refuse to start against a missing database instead of creating an empty one.

## Architecture

```text
Claude exports ─┐
                ├─> normalization / reconciliation
Gemini exports ─┘            │
                             ▼
              persistence (SQLite: observations, runs, capability state)
                             │
                             ▼
                        ToolService ──> authorization policy <── trusted directory + env grants
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
      Admin UI           Fastify API        MCP (stdio)
```

- Claude and Gemini keep separate observation types and are combined only at query time.
- `ToolService` owns application behavior and policy is enforced below it. Admin, HTTP and MCP are thin transports; none contains policy, and none reads identity, role, scope or group from arguments, bodies or prompt text.
- Domain and authorization code import no Fastify, React, database or MCP packages.

## Mapping & Data Integrity

- **Mapping decisions.** Claude reports daily per-user tokens (cache read/creation, requests) plus a separate cost report in decimal cents. Gemini reports per-project, per-SKU billing rows in USD with no request count. The two are never merged at ingestion. A platform with usage but no cost rows returns `data_unavailable`, never zero.
- **User/group attribution fails closed.** Claude rows resolve by user id/email and must agree with the group's RBAC id. Gemini rows resolve the owner email to a user and the project to a group; the `team` label must match that group and the user must belong to it. Any conflict or unknown identity leaves the row unresolved and excluded.
- **Exact money.** Cost is persisted as `bigint` in 1e-8 USD, never floating point. Every artifact and row has a fingerprint.
- **Idempotent ingestion.** Same key and fingerprint is a replay (no new rows). Same key with a different fingerprint is a restatement: the prior row stays active and the new row is excluded and reported. Conflicting duplicates are never summed.
- **Reconciliation** compares raw source totals to normalized totals; unexplained deltas fail the run. Only `complete` and `complete_with_exclusions` runs persist; others are refused with zero writes.
- **Periods** are `last_7_days`, `last_30_days`, an ISO week (`2026-W36`) or a month (`2026-09`). Relative periods anchor to the end of the data window, 2026-09-28 (exclusive).

```text
permission denied != no data       no data != zero usage
missing source    != deletion      replay  != restatement
```

## Authorization & Capability Controls

The trusted directory and the environment YAML are authoritative. Unknown users, environments, roles, scopes or conditions deny.

| Caller         | Env          | Read own | Read foreign | Write own | Write foreign |
| -------------- | ------------ | -------- | ------------ | --------- | ------------- |
| member         | dev          | yes      | yes          | no        | no            |
| member         | staging/prod | no       | no           | no        | no            |
| team lead      | dev          | yes      | yes          | yes       | no            |
| team lead      | staging      | yes      | no           | yes       | no            |
| team lead      | prod         | yes      | no           | no        | no            |
| platform admin | all          | yes      | yes          | yes       | yes           |

Dev is permissive per `dev.yaml`; staging and prod use production visibility, and prod restricts writes to platform admins. Prod enables `usage-connector` only for `it-platform` and `clinical-operations`; `code-execution` is off outside dev.

**Enforced in** the policy engine beneath `ToolService`: role + scope + target group, identical for Admin, HTTP and MCP.

- Non-admins get the same `group_not_permitted` denial for foreign and unknown groups, so group existence does not leak.
- A read requires `usage-connector` enabled for the **caller's home group**; otherwise it is denied with `capability_disabled`. This gates `usage_summary`, `top_users` and `capability_status`.
- `set_capability` is the recovery exception: it is not gated by `usage-connector`, so a disabled connector can be re-enabled. It still requires the role, the `capabilities:write` scope and a permitted target group.
- Denials are `{error: "permission_denied", code, reason, required_scope?}` and carry no protected data.

## Interfaces

### HTTP API

```text
GET  /api/usage-summary?period=…[&group=…]
GET  /api/top-users?period=…[&group=…][&limit=…]
GET  /api/capabilities[?group=…]
POST /api/capabilities/:group/:capability      body: {"enabled": true|false}
```

`period` is required on the first two. `X-Meridian-User-Id` is the simulated identity; role, scope and group always come from the directory. A missing or unknown id returns 401 `identity_unresolved` before validation. The API is a thin Fastify transport over `ToolService` and serves dev, staging and prod, each applying its own grants.

```bash
curl -H "X-Meridian-User-Id: user_E7691888F28227066DD2FB86" \
  "http://127.0.0.1:3200/api/usage-summary?period=2026-W36"
```

### Admin UI

`apps/admin` is server-rendered with a simulated caller selector, per-group usage, top users and capability controls with an Enable/Disable recovery path. It has no authentication, so it requires an explicit `MERIDIAN_ENV` and refuses `prod`.

### MCP

```text
usage_summary(group?, period)
top_users(group?, period, limit?)
capability_status(group?)
set_capability(group, capability, enabled)
```

- `period` is required for `usage_summary` and `top_users`. `limit` is 1-25 (default 10). `group` defaults to the caller's home group; `set_capability` requires it.
- Identity comes only from `MERIDIAN_ACTOR_USER_ID`. Malformed or extra arguments (including `user_id`, `role`, `scope`) are rejected as `invalid_input`.
- stdout carries JSON-RPC only; diagnostics go to stderr. Captured session: `docs/part-b-transcript.md`.

## Provisioning & Platform Registration

`pnpm provision <env>` writes `generated/<env>/` (git-ignored):

| File                                      | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `meridian.sqlite`                         | Seeded database and capability defaults                           |
| `permissions.json`                        | Scopes, roles, visibility and defaults rendered from the YAML     |
| `claude.mcp.json`, `gemini.settings.json` | Host registration snippets (`.mcp.json`, `.gemini/settings.json`) |
| `claude-plugin/<server_name>/`            | Claude plugin: `.claude-plugin/plugin.json`, `.mcp.json`, a skill |
| `gemini-extension/<server_name>/`         | Gemini CLI extension: `gemini-extension.json`, `GEMINI.md`        |

`<server_name>` comes from the environment YAML (`meridian-usage-dev`, `meridian-usage-staging`, `meridian-usage`).

- Output is deterministic and timestamp-free: reruns yield identical bytes and no duplicate rows. An unknown environment writes nothing and exits 1.
- Database paths resolve against the repository root, so servers work from any working directory. No actor identity is hard-coded; it is passed through `MERIDIAN_ACTOR_USER_ID`.
- `pnpm validate:provisioning` checks all three environments (files, valid JSON, byte-identical reruns, seeded defaults, unknown environment rejected).
- The plugin and extension launch the same MCP server through a small `launch.mjs` that finds the repository from its own real path, so a symlinked package works. Packages must stay inside this checkout. The standalone registration snippets use repository-relative paths and assume the host runs from the repository root.
- Claude: `claude --plugin-dir generated/<env>/claude-plugin/<server_name>` with `MERIDIAN_ACTOR_USER_ID` set. Gemini: `gemini extensions link generated/<env>/gemini-extension/<server_name>`; the extension declares the actor id as a setting.

Claude and Gemini registration/package artifacts are generated and validated by repository tests, including launching the packaged server from an unrelated directory and through a symlink. The underlying MCP server was exercised end-to-end. Host installation was not performed in the local development environment.

## Testing & CI

`pnpm check`: **536 automated non-browser tests**. `pnpm test:e2e`: **3 Playwright scenarios** against Admin in staging.

- Coverage: mapping, reconciliation, exact money, adversarial authorization, HTTP API, MCP protocol, Admin, provisioning and packaging, and real-process server tests.
- Playwright: team lead own group vs Finance; `usage-connector` disable and recovery; platform admin cross-group.

CI (`.github/workflows/ci.yml`, Node 22): job `verify` runs `pnpm check`, `pnpm test` under `TZ=America/Toronto` and `TZ=Asia/Kolkata`, and `pnpm validate:provisioning`; job `e2e` runs Playwright.

## Key Engineering Decisions

- **Separate Claude and Gemini observations:** sources differ (requests, cache tokens, per-SKU billing); merging hides gaps.
- **`bigint` 1e-8 USD:** exact sums, no float drift.
- **SQLite:** zero-infrastructure and transactional, sufficient at this scale.
- **One `ToolService` and policy below clients:** transports cannot diverge; adversarial tests target one place.
- **Handwritten minimal MCP stdio server:** four tools, small protocol surface, fully tested, no SDK dependency.
- **Deterministic provisioning:** reviewable environments; CI verifies identical reruns.

## Engineering Standards & Deliberate Omissions

Followed: strict TypeScript with no `any`; runtime validation of external data; fail-closed configuration and authorization; exact money; timezone-deterministic, process-level and browser tests; CI.

Intentionally skipped:

- Real authentication (OIDC). Identity is simulated and Admin refuses prod.
- TLS, CORS and rate limiting on the HTTP API.
- Managed or highly available database, and Kubernetes.
- Docker/container packaging: not implemented.
- Production observability stack.

## AI-Assisted Development

AI coding agents helped with planning, implementation, adversarial review and regression generation, one reviewed task at a time (`docs/tasks/`). Output was checked against the starter-kit contract rather than accepted as written. Human review overruled or caught:

- A migration that ran before the zero-write refusal for non-persistable runs.
- An unnecessary TypeScript downgrade and an ORM dependency used without benefit.
- `period` treated as optional; the contract requires it.
- MCP validation ordering that could reveal argument validity to denied callers.
- An Admin recovery gap when `usage-connector` is disabled, and Admin creating an empty database for a missing path.
- Packaging that was only registration snippets; plugin and extension packages were added after a requirements audit.

## With more time

- Install and exercise the plugin and extension in live Claude Code and Gemini CLI sessions.
- Add authenticated sessions to Admin so it could run beyond staging.

## In the real enterprise version

None of the following is implemented.

- OIDC/workload identity replaces the simulated user id and header.
- Managed relational persistence with formal migrations replaces SQLite.
- Scheduled ingestion from the real Claude and Google Cloud usage APIs.
- An organisation-level connector registry replaces per-group capability rows.
- Centralized audit logging, metrics and tracing.
- Container images, deployment pipelines, TLS, rate limiting and HA.
