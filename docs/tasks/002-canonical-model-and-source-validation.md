# 002 — Canonical Model and Source Validation

## Goal

Define the canonical usage and charge observation models and validate and normalize the Claude and Gemini starter-kit exports and the directory into them. Fail closed. Each source row produces exactly one outcome: `resolved`, `unresolved`, `rejected`, or `unsupported`.

## Approved Model

**Directory** (`starter-kit/data/directory`)

- `users.json` → `users[]`: `user_id`, `email`, `name`, `role`, `group_ids[]`, `claude_seat`, `gcp_principal`.
- `groups.json` → `groups[]`: `group_id`, `name`, `team_lead_user_id`, `claude_rbac_group_id`, `gcp_project_id`, `gcp_project_number`, `cost_centre`.

**Money:** `Money` is a `bigint` count of 1e-8 USD.

- Claude `amount`/`list_amount` are decimal strings in cents: units = cents × 10^6 (≤ 6 fractional digits).
- Gemini `cost` is USD: units = USD × 10^8 (≤ 8 fractional digits), parsed from the raw JSON lexeme.

**Time:** `UtcDay` is a valid UTC 24-hour `[start, end)` interval (`end = start + 24h`). Its day key is the UTC calendar date of `start`; `start` need not be midnight. Impossible calendar or clock values (for example `2026-02-30` or `T24:00:00Z`) are rejected, not normalized.

- Claude: `starting_at` / `ending_at` (RFC 3339, UTC).
- Gemini: `usage_start_time` / `usage_end_time` (`YYYY-MM-DD HH:MM:SS UTC`).
- Period comes only from usage timestamps. Never from `invoice.month` or `export_time`.
- ISO weeks are Monday-based, UTC.

**Count:** a non-negative integer, or `Unavailable`. Missing is never zero.

**UsageObservation** (discriminated by platform)

- Common: `user_id`, `group_id`, `period`, `model`, `dimension`.
- Claude: `dimension` = `product` (string). Tokens: `uncached_input`, `cache_read_input`, `cache_creation_5m_input`, `cache_creation_1h_input`, `output`; derived `input_total` = sum of the four input categories. `requests` and `web_search_requests` are Counts.
- Gemini: `dimension` = `workload` (agent label). Tokens: one `direction` (`input` | `output`) and `tokens: Count`. `requests`, `cache`, and `web_search` are `Unavailable`.

**ChargeObservation**

- Common: `user_id`, `group_id`, `period`, `model`, `dimension`, `amount: Money`.
- Claude: `charge_kind` = `tokens` | `web_search`. Has no request count and no directional split.
- Gemini: one charge per SKU row, carrying `direction` and the exported `cost`.

**Outcome** (per source row)

- `resolved`: a canonical observation.
- `unresolved`: attribution conflict or unknown identity. Carries a reason and a source reference. Never produces an observation.
- `rejected`: fails schema, money, or time validation.
- `unsupported`: a known-shape row whose semantics cannot be safely derived.

**Normalized dimensions:** Claude `product` and `model` are preserved as validated strings, not closed enums. Accepted if it is a non-empty string with no leading or trailing whitespace. No length or character-set limit applies. Gemini `model` comes from the explicit SKU map. Gemini `workload` is the `agent` label.

**Gemini SKU map** (explicit, closed):

- `D41E-77B0-2C1A` → Flash, input
- `D41E-77B0-2C1B` → Flash, output
- `8C7B-1A2E-9F03` → Pro, input
- `8C7B-1A2E-9F04` → Pro, output

**Attribution**

- Claude: `actor.user_id` and `actor.email` must both match the same directory user. `rbac_group_id` → group via `claude_rbac_group_id`. That group must be in the user's `group_ids`.
- Gemini: `owner` label → user by `email`. `project.id` → group via `gcp_project_id`. `project.labels` key `team` must equal that group's `group_id`. That group must be in the user's `group_ids`.

**Reconciliation:** Gemini `usage.amount × price.effective_price` vs `cost` is diagnostic only. It is reported and never changes the canonical amount.

## Invariants

1. External data starts as `unknown` and is runtime-validated at the adapter boundary.
2. Vendor field names (`actor`, `rbac_group_id`, `labels`, `sku`, `project`, `cost_type`, `server_tool_use`, etc.) never appear in domain types.
3. Money is `bigint` only. No `Number` arithmetic on money.
4. Missing is not zero. Gemini request, cache, and web-search values are `Unavailable`.
5. Claude requests come only from usage rows. Charges carry no request counts.
6. Canonical Claude input = uncached + cache read + 5m + 1h. Output is separate. `total_tokens` must equal the sum of the five token fields or the row is rejected.
7. Claude `product` and `model` are open strings (non-empty, no surrounding whitespace).
8. Unknown Gemini SKU IDs are `unsupported`. Direction and model are never inferred.
9. Attribution conflicts and unknown identities are `unresolved`. They never become resolved observations.
10. Exported Gemini `cost` is authoritative.
11. No Claude↔Gemini equivalence: no Claude product maps to a Gemini workload, no directional Claude cost is derived, and no Claude token cost is attributed to a Gemini agent.
12. `starter-kit/` is read-only.

## Out of Scope

- Ingestion pipeline, idempotency, concurrency, and persistence (Step 3).
- API, MCP, and authorization.
- Aggregation, `usage_summary`, `top_users`, and mixed-platform request totals.
- Provisioning and environment YAML.
- Fastify, React, Drizzle, and MCP SDK imports in the domain.
- Correcting README example values.

## MUST-HAVE Acceptance Tests

**Directory and source validation**

- D1: Duplicate `user_id`, `email`, `group_id`, `claude_rbac_group_id`, or `gcp_project_id`; unknown `team_lead_user_id`; unknown group in `group_ids` → rejected.
- V1: Claude usage row with a missing `cache_creation` field, a negative or non-integer token count, `total_tokens` ≠ sum, missing `web_search_requests`, `ending_at − starting_at` ≠ 24h, or a malformed or impossible timestamp (e.g. `2026-02-30`, `T24:00:00Z`) → rejected.
- V2: Gemini row with `unit` ≠ `count`, non-integer or negative `usage.amount`, missing `owner`/`project.id`/`sku.id`, malformed `usage_start_time`, or `usage_end_time` ≠ start + 24h → rejected.
- V3: New valid Claude product/model string (for example `cowork_v2`, `claude-future-model-1`) → resolved and preserved. Empty or whitespace-padded → rejected. Length and characters are not restricted.
- V4: Canonical observations contain no vendor field names; `product` and `workload` appear only as normalized dimensions.

**Money**

- M1: Cents `"88.900050"` → `88900050n`; `"1.000000"` → `1000000n`. All 1,838 Claude cost rows parse.
- M2: Gemini `cost` `0.107564` → `10756400n` from the raw lexeme.
- M3: Cents with >6 fractional digits, Gemini cost with >8 fractional digits, negatives, exponent notation, or non-numeric strings → rejected. No rounding.
- M4: Canonical Gemini amount equals the exported `cost`. The diagnostic price check does not alter it.

**Claude tokens**

- C1: Row `2026-08-03`, `chat`, `claude-opus-5-5`, user `user_E7691888F28227066DD2FB86`: uncached 14,562; cache read 31,297; 5m 3,516; 1h 1,175; output 6,966; requests 7. Canonical `input_total` = 50,550; `output` = 6,966.
- C2: Claude charges expose no directional cost fields. `tokens` charge is one amount.
- C3: Charge rows (`tokens`, `web_search`) produce no request counts; request count comes only from the usage row.
- C4: `web_search_requests: 0` → `Count(0)`. Absent field → rejected.

**Gemini SKUs**

- G1: Each of the four SKU IDs maps to its (model, direction). Each row yields one direction-specific observation.
- G2: Unknown SKU ID → `unsupported`. No usage or charge emitted.
- G3: SKU ID ↔ description mismatch, or `model` label ≠ SKU model → rejected.
- G4: Non-empty `credits`, non-null `adjustment_info`, `cost_type` ≠ `regular`, or `currency` ≠ `USD` → `unsupported`.
- G5: Gemini `requests`, cache, and `web_search` are `Unavailable`, not `0`.

**Attribution**

- A1: Fixture Claude row resolves to `user_E7691888F28227066DD2FB86` and group `clinical-operations`.
- A2: Fixture Gemini row (owner `priya.nair@meridianls.example`, project `meridian-clinops-prod`, team label `clinical-operations`) resolves.
- A3: Synthetic Claude conflicts (`user_id` ↔ `email` mismatch, unknown `rbac_group_id`, group not in `group_ids`, unknown `user_id`) → `unresolved` with reason.
- A4: Synthetic Gemini conflicts (unknown owner, unknown `project.id`, team label ≠ project's group, group not in owner's `group_ids`) → `unresolved` with reason.
- A5: No `unresolved` row produces a UsageObservation or ChargeObservation.

**Time**

- T1: Claude row `starting_at = 2026-08-04T00:00:00.000Z` belongs to 2026-08-04, not 2026-08-03.
- T2: Gemini `usage_start_time = "2026-08-05 00:00:00 UTC"` → 2026-08-05. Synthetic row with `invoice.month = 202609` or a later `export_time` still lands on its usage day.
- T3: ISO week boundaries: `2026-08-03` → W32; `2026-08-09T23:59:59Z` → W32; `2026-08-10` → W33; `2026-09-27` → W39; `2026-09-28` → outside W32–W39.
- T4: Day and week assignment is identical under `TZ=America/Toronto` and `TZ=Asia/Kolkata`.

**Unsupported and no-equivalence**

- U1: Claude `cost_type` not in {`tokens`, `web_search`} → `unsupported`.
- U2: Claude `currency` ≠ `USD` → unsupported.
- U3: No Claude-derived value appears in any Gemini observation, and no Gemini workload appears as a Claude product.

**Fixture-wide reconciliation**

- F1: All 1,346 Claude usage rows validate. Each of the 1,346 `tokens` charges and 492 `web_search` charges pairs to exactly one usage row on (`user_id`, `starting_at`, `product`, `model`). No orphans.
- F2: All 990 Gemini rows validate and resolve. Distinct usage days = 55. Missing day 2026-08-23 is recorded as a gap, not zero rows.
- F3: Canonical cost sums (bigint) per platform equal an independent decimal sum of the raw strings.
- F4: Gemini price check: |cost − usage × effective_price| > 1e-6 USD is reported as a diagnostic. Fixture max delta is 5e-7 USD. No canonical value changes.
- F5: Every fixture observation is assigned to exactly one ISO week in W32–W39.
- F6: Starter-kit file hashes are unchanged after the test run.

## Required Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
TZ=America/Toronto pnpm test
TZ=Asia/Kolkata pnpm test
pnpm check
```
