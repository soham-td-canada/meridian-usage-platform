# 004 — Persistence and Capability State

## Goal

Persist trusted Step 3 ingestion state into SQLite using Drizzle and better-sqlite3, while preserving exact data semantics, replay/idempotency, privacy and transactional integrity.

Also persist the per-group capability state required by the later MCP/API contract.

Step 4 must:

- persist only trusted ingestion results;
- preserve exact money values;
- preserve replay/restatement semantics across process restarts;
- never persist raw vendor payloads or raw source-key text;
- materialize capability state explicitly;
- seed environment defaults without overwriting later changes;
- remain independent of authorization, API, MCP and UI concerns.

---

## Approved Technology

Use:

```text
SQLite
Drizzle ORM
better-sqlite3
```

Requirements:

- Node 22+;
- `PRAGMA foreign_keys = ON`;
- file-backed SQLite for reload/restart tests;
- WAL mode for file-backed application DB;
- synchronous transactions;
- `BEGIN IMMEDIATE` semantics for ingest-and-persist.

If pnpm requires explicit native build approval for `better-sqlite3`, configure only the minimum required build permission.

No hosted database is required.

---

## Step 3 Compatibility Change

Before persistence is implemented, make the smallest required Step 3 compatibility change.

Current:

```text
IngestionState.active
raw source key → ActiveRow
```

Target:

```text
IngestionState.active
keyDigest → ActiveRow
```

Requirements:

- add one canonical `keyDigestOf(rawSourceKey)` helper;
- `ActiveRow` stores `keyDigest`, not raw key text;
- in-run duplicate/conflict grouping may still use the raw key internally;
- all prior-state lookups use the digest;
- `priorKeysAbsent` compares digests to digests;
- active-state deterministic sorting uses digest ordering;
- raw source-key text must not escape Step 3 processing;
- existing Step 3 fixture totals/statuses must remain unchanged.

Mandatory regression test:

```text
ingest
→ serialize/rebuild prior state using digests
→ ingest identical artifacts again
```

Expected:

```text
accepted = 0 new rows
replayed = all existing active rows
priorKeysAbsent = 0
state.active unchanged
```

Also export the existing typed directory loader needed by persistence. Do not create a second directory parser.

---

## Persistence Boundary

Persistence must not accept a caller-provided trusted status or arbitrary `IngestionResult`.

The primary orchestration boundary is conceptually:

```ts
ingestAndPersist({
  db,
  artifacts,
  environment,
  recordedAt,
});
```

Inside one database transaction:

```text
load prior state
→ run Step 3 ingest
→ inspect status/reconciliation
→ persist if eligible
→ verify written state
→ commit
```

This prevents a caller from forging a `complete` result.

---

## Run Persistence Policy

### `complete`

Persist trusted state.

### `complete_with_exclusions`

Persist:

- trusted active state;
- accepted observations;
- artifact metadata;
- directory snapshot metadata;
- minimal exclusion/run metadata.

Do not persist raw excluded rows.

Restatements remain excluded and do not replace prior active values.

### `partial`

Refuse persistence.

```text
zero database writes
```

### `failed`

Refuse persistence.

```text
zero database writes
```

### `blocked`

Refuse persistence.

```text
zero database writes
```

Return a typed refusal result rather than throwing for expected status refusal.

A refused run does not insert an ingestion-run audit row because the policy is zero writes.

---

## Restatement and Absence Policy

Step 4 preserves Step 3 semantics.

### Restatement

```text
same key digest
different source fingerprint
```

Behaviour:

```text
prior active row remains
new row stays excluded
no replacement occurs
```

Step 4 does not implement a restatement-resolution workflow.

### Missing prior key

A later artifact omitting an existing active key means:

```text
no deletion
no tombstone
prior row remains active
```

---

## Schema

Keep the schema minimal.

Required tables:

```text
source_artifacts
directory_snapshots

users
groups

active_source_rows
usage_observations
charge_observations

ingestion_runs
run_excluded_rows

capability_state
```

Do not add:

- event sourcing;
- audit-history framework;
- raw payload tables;
- tombstone tables;
- mutable membership history;
- restatement replacement history.

---

## `source_artifacts`

Purpose:

Track successfully parsed source artifact versions.

Columns conceptually:

```text
source
sha256
byte_length
```

Primary key:

```text
(source, sha256)
```

Only artifacts successfully parsed and eligible for persistence are inserted.

No raw bytes or payload text are stored.

---

## `directory_snapshots`

Purpose:

Track which directory version was used for attribution.

Columns:

```text
sha256 PRIMARY KEY
first_seen_run_id
```

Keep this table intentionally small.

A directory digest is provenance, not a mutable "current identity database".

---

## `users`

Reporting dimension only.

Columns:

```text
user_id PRIMARY KEY
name
```

Do not persist in Step 4:

```text
email
role
gcp_principal
Claude identity fields
```

Rows are append-only.

Do not rewrite historical identity semantics from a later directory snapshot.

---

## `groups`

Reporting dimension only.

Columns:

```text
group_id PRIMARY KEY
name
```

Rows are append-only.

Do not persist vendor attribution identifiers unless later implementation proves they are required.

Do not add a mutable `user_group_memberships` table in Step 4.

Step 5 authorization must use its trusted directory/auth context rather than infer historical authorization from reporting dimensions.

---

## `active_source_rows`

Purpose:

Rebuild Step 3 prior state after restart.

Columns:

```text
key_digest PRIMARY KEY
source
fingerprint
artifact_sha256
directory_sha256
row_index
```

Foreign keys:

```text
(source, artifact_sha256)
→ source_artifacts

directory_sha256
→ directory_snapshots
```

No raw source key text.

No raw vendor payload.

`key_digest` is pseudonymous, not anonymous; document this.

---

## Observation Identity

Do not reconstruct a unique key from canonical fields.

The source identity is authoritative.

A canonical natural key such as:

```text
platform + user + day + model + dimension
```

is insufficient because Step 3 source identity contains dimensions that canonical observations intentionally discard.

Therefore observation uniqueness is based on:

```text
source key digest
+
observation kind / ordinal
```

Example:

```text
(key_digest, observation_kind, ordinal)
```

Gemini may emit both:

```text
usage
charge
```

for one source row.

Claude source rows emit one relevant observation each.

Foreign keys must use:

```text
ON DELETE RESTRICT
```

---

## `usage_observations`

Persist the canonical usage model without vendor raw structures.

Common columns:

```text
key_digest
ordinal
platform
user_id
group_id
period_day
iso_week
model
dimension
```

Claude-specific nullable columns:

```text
uncached_input
cache_read_input
cache_creation_5m_input
cache_creation_1h_input
output
input_total
requests
web_search_requests
```

Gemini-specific:

```text
direction
tokens
```

Requirements:

- platform is constrained to `claude | gemini`;
- platform-specific nullability is enforced by CHECK constraints;
- counts must be non-negative integers;
- `input_total` equals the four Claude input components;
- Gemini unavailable request/cache/web-search semantics must reconstruct as `Unavailable`, never `0`.

Do not create columns for Gemini metrics that are always unavailable.

---

## `charge_observations`

Columns conceptually:

```text
key_digest
ordinal
platform
user_id
group_id
period_day
iso_week
model
dimension
charge_kind
direction
amount_usd_e8
```

Claude:

```text
charge_kind = tokens | web_search
direction = NULL
```

Gemini:

```text
charge_kind = NULL
direction = input | output
```

Add platform-shape CHECK constraints.

---

## Money Storage

Canonical unit remains:

```text
1 = $0.00000001 USD
```

Money is a TypeScript:

```text
bigint
```

SQLite storage:

```text
INTEGER
```

Before opening the persistence transaction, validate:

```text
0 <= amount <= 9223372036854775807
```

Anything outside signed SQLite int64 range returns a typed persistence error with zero writes.

Do not convert money through JavaScript `number`.

Mandatory driver spike/tests:

```text
0n
1n
2^53 + 1
2^63 - 1
```

must round-trip exactly.

If Drizzle/better-sqlite3 does not return exact bigint through the normal mapper:

- use raw better-sqlite3 statements with safe integer handling for money;
- do not accept a lossy `number`.

SQL `SUM` must never be consumed as a lossy JS number.

Prefer application-side bigint aggregation when necessary.

---

## Counts

Canonical count semantics must survive reload.

Known count:

```ts
{ kind: 'known', value: number }
```

Unavailable:

```ts
{
  kind: 'unavailable';
}
```

must remain distinct.

A known zero must round-trip as zero.

Unavailable must never become zero.

---

## Time

Persist:

```text
period_day = YYYY-MM-DD
iso_week   = YYYY-Www
```

Both derive from the Step 2/Step 3 UTC semantics.

No local timezone calculation is permitted.

Reporting indexes may use these stored values directly.

---

## Indexes

Create indexes needed by later reporting from the first migration.

At minimum:

```text
usage(platform, period_day)
usage(group_id, period_day)
usage(user_id, period_day)
usage(platform, group_id, iso_week)

charges(platform, period_day)
charges(group_id, period_day)
charges(platform, group_id, iso_week)
```

The exact column ordering may be tuned, but tests must prove the intended query paths use indexes where practical.

Do not optimize speculative queries.

---

## Ingestion Runs

`ingestion_runs` is an append-only record of **successfully persisted** runs.

It is not the idempotency key for active data.

Columns may include:

```text
id
status
directory_sha256
recorded_at

rows_total
accepted
replayed
duplicates
conflicts
restatements
quarantined
prior_keys_absent

checks_failed
checks_not_run
```

`recorded_at` is injected by the caller.

It is metadata only and never influences identity.

Data-table idempotency is the important invariant.

Do not require repeated calls to produce identical run-table row counts unless the chosen repository API explicitly deduplicates run records.

---

## Exclusion Metadata

For `complete_with_exclusions`, `run_excluded_rows` may contain:

```text
run_id
source
artifact_sha256
row_index
key_digest
fingerprint
disposition
reason_code
```

Never store:

```text
raw payload
raw key text
email
free-form source error message
```

Store enough aggregate information on `ingestion_runs` to show whether exclusions affected:

```text
tokens
money
```

and whether any excluded measure was unmeasurable.

Do not build a second reconciliation database.

---

## Directory Drift

Each persisted active row keeps:

```text
directory_sha256
```

representing the directory used for its attribution.

Later directory snapshots do not rewrite historical observations.

This means the active dataset may contain rows attributed under different directory snapshots.

That is intentional.

If unchanged raw source data produces changed normalized observations under a new directory, Step 3 continues to classify that as:

```text
directory_changed
```

restatement behaviour.

Persist/reload tests must preserve enough provenance for that classification to remain `directory_changed`, not degrade to `observation_changed`.

---

## Transaction

For eligible runs:

```text
BEGIN IMMEDIATE
```

Then:

1. load persisted prior `IngestionState`;
2. run Step 3 ingestion;
3. verify status is persistable;
4. insert/upsert artifact metadata;
5. insert directory snapshot metadata;
6. insert append-only users/groups if missing;
7. insert new active source rows;
8. insert corresponding canonical observations;
9. record exclusions/run metadata where applicable;
10. seed any missing capability rows for known groups;
11. run minimal post-write integrity checks;
12. commit.

Any error:

```text
ROLLBACK
```

The transaction callback must remain synchronous.

---

## Minimal Post-Write Integrity Checks

Do not recreate all Step 3 reconciliation in SQL.

Check only enough to prove persistence did not mutate trusted state:

```text
persisted active-row count
persisted usage count
persisted charge count
money totals by platform
token totals by platform
```

Compare with the trusted Step 3 state.

Any mismatch:

```text
rollback
typed persistence failure
```

---

## Reload Contract

Persistence must reconstruct an `IngestionState` that is semantically equivalent to the persisted Step 3 active state.

Mandatory requirement:

```text
persist fixture
close DB
reopen DB
load prior state
re-ingest identical fixture
```

Expected:

```text
status = complete
all persisted rows = replay
zero restatements
zero new active data rows
priorKeysAbsent = 0
```

Observation serialization after reload must reproduce Step 3 observation equality semantics exactly.

---

# Capability State

## Capability Domain

Add the infrastructure-free domain type:

```ts
export const CAPABILITIES = ['usage-connector', 'web-search', 'code-execution'] as const;
```

Capability parsing is:

- exact;
- case-sensitive;
- no aliases;
- no trimming.

These are invalid:

```text
Web-Search
web_search
 web-search
```

---

## Capability Table

```text
capability_state
```

Columns:

```text
group_id
capability
enabled
updated_at
updated_by
```

Primary key:

```text
(group_id, capability)
```

Constraints:

```text
capability IN (
  'usage-connector',
  'web-search',
  'code-execution'
)

enabled IN (0,1)
```

Seeded rows:

```text
updated_at = NULL
updated_by = NULL
```

Changed rows:

```text
updated_at != NULL
updated_by != NULL
```

The repository must preserve that invariant.

---

## Capability Defaults

Environment is a strict closed set:

```text
dev
staging
prod
```

Unknown environment:

```text
fail closed
```

Environment defaults:

### dev

All three capabilities enabled for every group.

### staging

```text
usage-connector = enabled
web-search      = enabled
code-execution  = disabled
```

for every group.

### prod

```text
web-search      = enabled
code-execution  = disabled
```

for every group.

`usage-connector` enabled only for:

```text
it-platform
clinical-operations
```

and disabled for all other groups.

Represent defaults as typed application/config constants.

Do not parse `starter-kit/` YAML at runtime.

Add a test-only parity check proving the constants match the supplied YAML.

---

## Capability Initialization

Initialization receives the trusted set of directory groups.

For every:

```text
group × capability
```

insert a row if absent.

Use:

```text
INSERT ... ON CONFLICT DO NOTHING
```

Requirements:

- first successful initialization creates 18 rows for the supplied six groups;
- repeated initialization is idempotent;
- existing admin-changed state is never overwritten;
- a newly added valid group receives its missing capability rows on the next seed;
- unknown environment fails;
- invalid/default capability names fail;
- config naming a group that does not exist fails closed.

A missing capability-state row after initialization is an integrity error.

Downstream Step 5 must treat such a condition as fail-closed/denied, never enabled.

---

## Capability Repository

Conceptual API:

```ts
interface CapabilityRepository {
  initialize(groups: readonly GroupId[], environment: Environment): InitResult;

  list(group?: GroupId): readonly CapabilityState[];

  set(input: {
    group: GroupId;
    capability: Capability;
    enabled: boolean;
    updatedBy: UserId;
    updatedAt: string;
  }): CapabilityState;
}
```

Authorization is not part of this repository.

`updatedBy` and `updatedAt` are trusted server-context inputs.

No hidden `Date.now()` inside the repository.

---

## Capability Set Semantics

Changing:

```text
false → true
```

or:

```text
true → false
```

updates:

```text
enabled
updated_at
updated_by
```

Use a conditional SQL update:

```text
UPDATE ...
WHERE group_id = ?
  AND capability = ?
  AND enabled <> ?
```

If the stored value already equals the requested value:

```text
no update
```

Return the existing state unchanged.

Therefore same-value set does not alter:

```text
updated_at
updated_by
```

Unknown group:

```text
typed unknown_group error
no write
```

Unknown capability:

```text
typed unknown_capability error
no write
```

Missing initialized state:

```text
typed state_missing integrity error
no implicit upsert
```

---

## Privacy Rules

The persisted DB must not contain:

```text
raw source-key text
Gemini owner email
directory email
raw Claude JSON
raw Gemini JSONL
quarantined raw payload
free-form source parse messages
```

`key_digest` is permitted and documented as pseudonymous.

Tests must inspect:

- table text values;
- SQLite DB bytes where useful;
- WAL bytes where applicable;

for known fixture emails/raw-key fragments.

---

## Invariants

1. Only `complete` and `complete_with_exclusions` modify durable state.
2. `partial`, `failed`, and `blocked` produce zero writes.
3. Raw source-key text is never persisted.
4. Raw vendor payloads are never persisted.
5. Active source identity is unique by key digest.
6. Observation identity derives from the active source row, not a reconstructed natural key.
7. Prior active rows are never silently replaced.
8. Missing rows in later artifacts are never deleted.
9. Money remains exact bigint in 1e-8 USD units.
10. Out-of-int64 money is rejected before transaction writes.
11. Known zero and unavailable counts remain distinct.
12. Reloading persistence recreates replay-compatible Step 3 state.
13. Directory attribution provenance survives reload.
14. Capability state contains exactly one row per known group × capability.
15. Capability initialization never overwrites existing state.
16. Unknown environment/configuration fails closed.
17. Same-value capability changes are no-ops.
18. No Step 5 authorization logic appears in persistence.

---

## Out of Scope

- authorization;
- role evaluation;
- permission-denial mapping;
- API;
- MCP;
- React/admin UI;
- usage-summary implementation;
- top-users implementation;
- hosted database;
- Postgres;
- restatement replacement;
- tombstones;
- capability history/audit log;
- event sourcing;
- queues/workers;
- live vendor APIs;
- mutable historical directory authorization state.

---

## MUST-HAVE Acceptance Tests

### Step 3 compatibility

**C1**

Digest-keyed state produces the same clean fixture result as before.

**C2**

Persist/rebuild/re-ingest returns all rows as replay with:

```text
accepted new = 0
restatements = 0
priorKeysAbsent = 0
```

---

### Schema / migration

**M1**

Fresh DB creates all required tables, constraints and indexes.

**M2**

Migration application is repeat-safe.

**M3**

Foreign keys are enabled.

**M4**

Direct invalid FK insertion fails.

---

### Clean fixture persistence

**P1**

Full starter-kit Step 3 run:

```text
status = complete
```

persists successfully.

**P2**

Persisted active/usage/charge counts exactly match Step 3.

**P3**

Every persisted canonical observation reloads to an equivalent domain observation.

**P4**

No raw payload or raw source key is present.

---

### Money

**$1**

Round-trip exactly:

```text
0n
1n
9007199254740993n
9223372036854775807n
```

**$2**

Value above SQLite signed-int64 range is rejected before any write.

**$3**

Fixture platform money totals equal the Step 3 totals exactly as bigint.

---

### Idempotency / replay

**I1**

Persist fixture once.

Re-ingest identical artifacts after reload.

No new active or observation rows are created.

**I2**

No replay becomes `observation_changed`.

**I3**

Directory SHA provenance round-trips.

---

### Restatement

**R1**

Changed fingerprint:

```text
prior remains
new version excluded
no active replacement
```

**R2**

Missing prior key:

```text
no deletion
```

---

### Status policy

Table-driven:

```text
complete                 → persist
complete_with_exclusions → persist trusted state
partial                  → refuse / zero writes
failed                   → refuse / zero writes
blocked                  → refuse / zero writes
```

**S1**

Refused persistence leaves an existing good DB byte-for-byte/logically unchanged.

**S2**

Status handling is exhaustive at compile time.

---

### Transaction

**T1**

Inject a failure after some inserts.

Expected:

```text
rollback
no partial rows
```

**T2**

A subsequent clean persistence succeeds.

---

### Directory drift

**D1**

Rows attributed under an older directory retain their original persisted attribution.

**D2**

Reload preserves directory SHA sufficiently for later `directory_changed` classification.

---

### Privacy

**V1**

Scan persisted table values for all supplied directory emails:

```text
no match
```

**V2**

No persisted source key contains `@`.

**V3**

No raw JSON/JSONL fixture row text is stored.

---

### Capability defaults

**K1 — dev**

All six groups × three capabilities enabled.

**K2 — staging**

```text
usage-connector true
web-search true
code-execution false
```

for every group.

**K3 — prod**

`usage-connector` true only for:

```text
it-platform
clinical-operations
```

`web-search` true everywhere.

`code-execution` false everywhere.

**K4**

Typed defaults match starter-kit YAML in a test-only parity check.

---

### Capability initialization

**K5**

First initialization creates 18 rows.

**K6**

Second initialization creates zero duplicates and changes nothing.

**K7**

Changing a stored value and reinitializing does not reset it.

**K8**

A new known group receives its missing capability rows.

**K9**

Unknown environment/default group/capability configuration fails closed.

---

### Capability updates

**U1**

Actual value change persists:

```text
enabled
updated_at
updated_by
```

**U2**

Same-value set is a no-op and preserves existing metadata.

**U3**

Unknown group:

```text
typed error
zero writes
```

**U4**

Unknown capability:

```text
typed error
zero writes
```

**U5**

Missing capability row:

```text
state_missing
```

rather than implicit creation.

**U6**

Close and reopen the DB; changed capability state remains.

---

### Query/index paths

**Q1**

Queries by:

```text
platform + period
group + period
user + period
platform + group + week
```

return deterministic correct results.

**Q2**

`EXPLAIN QUERY PLAN` demonstrates intended indexes are actually used for the principal paths where SQLite's planner reasonably selects them.

---

### Timezone

All persistence/reload tests pass under:

```text
TZ=America/Toronto
TZ=Asia/Kolkata
```

---

### Fixture safety

Starter-kit file hashes are identical before and after all tests.

---

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

All must pass before Task 004 is complete.
