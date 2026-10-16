# 003 — Ingestion and Reconciliation

## Goal

Ingest the Claude, Gemini and directory artifacts into an in-memory, deterministic, replay-safe state using the Step 2 validators, then independently reconcile raw source controls against the normalized observations.

Fail closed:

- no row contributes unless it is unambiguous;
- every exclusion is visible and explained;
- duplicate and conflicting rows are never silently counted;
- tokens and money reconcile with zero unexplained delta;
- fatal integrity failures make the ingestion run fail.

Step 3 uses the Step 2 adapters and canonical model. It does not replace or redesign them.

---

## Approved Architecture

- Step 3 is **in-memory only**.
- No SQLite, Drizzle, files written, or persistent tables.
- Persistence is Step 4.

Conceptually:

```text
raw source artifacts
        ↓
artifact fingerprinting
        ↓
source-row identity + fingerprint
        ↓
Step 2 validation / normalization
        ↓
Step 3 disposition
        ↓
active normalized observations
        ↓
independent reconciliation
        ↓
IngestionResult
```

The primary orchestration contract is conceptually:

```ts
ingest(
  artifacts,
  priorState?,
): {
  state: IngestionState;
  report: IngestionReport;
}
```

Requirements:

- no clock-dependent behaviour;
- no random IDs;
- no timestamps generated merely for ingestion identity;
- output ordering is deterministic;
- identical inputs produce identical outputs.

`IngestionState` is a plain in-memory value passed in and out. It holds active rows by source key together with:

- fingerprint;
- normalized observations;
- provenance metadata.

SHA-256 hashing uses `node:crypto` inside `packages/ingestion`.

`packages/domain` must remain infrastructure-free.

Step 2 outcomes:

```text
resolved
unresolved
rejected
unsupported
```

remain distinct from Step 3 ingestion dispositions.

Reconciliation lives in its own module.

The **raw-control reconciliation path must be independent** of the Step 2 normalization path.

Raw controls must not reuse Step 2:

- money parsing;
- attribution;
- normalization;
- canonical observation construction.

Raw controls operate directly on raw source values using exact integer/string arithmetic.

No floating-point arithmetic is permitted for money reconciliation.

Step 3 reconciliation controls remain platform-local. This does not prohibit later cross-platform reporting.

---

## Source / Artifact / Row Identity

### Artifact identity

An artifact is identified by:

```text
source kind + SHA-256(raw bytes)
```

Supported source kinds:

```text
directory
claude_usage
claude_cost
gemini_billing
```

Filename, modification time, export timestamp and date window are not artifact identity.

Example conceptual representation:

```ts
interface SourceArtifact {
  readonly source: 'directory' | 'claude_usage' | 'claude_cost' | 'gemini_billing';

  readonly sha256: string;
  readonly byteLength: number;
}
```

Rules:

- identical raw bytes → identical artifact SHA;
- same source kind + same SHA → same artifact version;
- same source kind + different SHA → new artifact version;
- re-ingesting identical bytes is replay-safe.

---

### Source row keys

Source-native keys are extracted from raw fields **before semantic validation whenever possible**.

#### Claude usage

```text
(
  user_id,
  starting_at,
  product,
  model,
  context_window,
  inference_geo,
  speed
)
```

#### Claude cost

```text
(
  user_id,
  starting_at,
  product,
  model,
  context_window,
  inference_geo,
  speed,
  cost_type
)
```

The source-only dimensions are retained in the ingestion identity even though they do not need to appear in canonical domain observations.

This prevents future rows that differ only by pricing/runtime context from being mistaken for duplicates.

#### Gemini billing

```text
(
  billing_account_id,
  sku.id,
  usage_start_time,
  project.id,
  owner,
  agent,
  model
)
```

The following are **not** part of the row key:

```text
cost
export_time
invoice.month
```

A row whose key cannot be extracted because a key field is missing or malformed:

- is quarantined by `SourceRef`;
- is never deduplicated;
- is never conflict-compared against keyed rows.

---

### Row fingerprint

Each raw row receives a SHA-256 fingerprint of a deterministic canonical representation of that raw row.

Requirements:

- object keys sorted deterministically;
- insignificant JSON whitespace ignored;
- numeric lexemes preserved where significant;
- raw vendor content drives the fingerprint;
- canonical observations do not drive the fingerprint.

Thus:

```text
same semantic JSON with different key order
→ same fingerprint
```

but:

```text
0.107564
vs
0.1075640
→ different fingerprint
```

The fingerprint detects changes that may not survive normalization.

---

### Provenance

Each processed source row carries:

```text
source kind
artifact SHA-256
SourceRef
source row key, if extractable
raw-row fingerprint
```

Canonical observations themselves remain free of raw vendor structures.

---

## Ingestion Dispositions

Every source row receives exactly one Step 3 disposition.

The disposition model must be a closed discriminated union handled exhaustively.

### `accepted`

Meaning:

- source key is unique in the run;
- Step 2 outcome is `resolved`;
- no restatement against prior state exists.

Contribution:

```text
YES
```

---

### `duplicate`

Meaning:

- same source key;
- same fingerprint;
- another equivalent row is already active for the run.

Behaviour:

- count once;
- extras are reported;
- duplicate extras do not contribute again.

Contribution:

```text
NO
```

---

### `conflict`

Meaning:

- same source key;
- multiple distinct fingerprints exist within the same run.

Behaviour:

- all versions under that key are excluded;
- no ordering rule selects a winner;
- applies even if one version would otherwise be rejected or unresolved by Step 2.

Contribution:

```text
NO
```

---

### `restatement`

Meaning:

- source key already exists in `priorState`;
- new artifact contains the same source key with a different fingerprint.

Behaviour:

- prior active value remains active;
- new version is quarantined and reported as a restatement;
- Step 3 does not decide replacement policy.

Contribution of new version:

```text
NO
```

Step 4 may later introduce an explicit persistence/replacement policy.

---

### `quarantined`

Meaning:

Step 2 produced:

```text
rejected
unresolved
unsupported
```

or a source key could not be extracted.

Quarantine records retain only:

```text
SourceRef
source key, if available
fingerprint
disposition
reason code
```

Raw payloads are not retained in quarantine.

Contribution:

```text
NO
```

---

## Ingestion Rules

Conflict detection groups rows by source key before resolved observations are accepted.

Results must not depend on:

- row order;
- artifact order;
- source processing order.

Rules:

```text
same key + same fingerprint
→ one active row + duplicate records
```

```text
same key + different fingerprints in same run
→ conflict
→ all conflicting versions excluded
```

```text
prior state same key + same fingerprint
→ replay / no-op
```

```text
prior state same key + different fingerprint
→ restatement
→ prior remains active
→ new row excluded
```

Absence of an existing prior key from a later artifact does **not** imply deletion.

No tombstones are created.

A report may state how many prior keys were absent from the later artifact, but this has no effect on active state.

---

## File-Level Failure Rules

A file-level failure includes situations such as:

- unreadable JSON;
- malformed Claude envelope;
- missing required Claude `data` array;
- torn/truncated Gemini JSONL line;
- unusable source structure.

A file-level failure applies to the entire source artifact.

It must not invent row outcomes for rows that cannot reliably be parsed.

Directory failure is special because attribution depends on it.

---

## Reconciliation Model

Reconciliation compares:

```text
Path A — independent raw controls
```

against:

```text
Path B — accepted canonical observations
```

The fundamental equation is:

```text
RAW
=
CANONICAL
+ EXPLAINED_EXCLUSIONS
+ UNEXPLAINED_DELTA
```

For tokens and money:

```text
UNEXPLAINED_DELTA === 0
```

is mandatory.

No tolerance is permitted.

---

## Explained Exclusions

Explained exclusions include safely measurable values belonging to:

- duplicate extras;
- conflicting rows;
- rejected rows;
- unresolved rows;
- unsupported rows;
- restatements.

If the independent raw-control path can safely parse the measure, that value goes into the explained-exclusion control.

Example:

```text
raw token total
=
accepted canonical token total
+ tokens belonging to excluded rows
```

If an excluded row contains an unparseable measure:

```text
measure = unmeasurable
```

It must not be guessed.

It must not be counted as zero.

A reconciliation bucket containing an unmeasurable excluded value cannot claim exact reconciliation for that measure.

---

## Independent Raw Controls

Raw controls must not import the Step 2:

```text
money parser
attribution engine
normalization functions
canonical observation adapters
```

### Claude money

Raw Claude:

```text
amount
```

is a decimal string in cents.

Independent conversion:

```text
USD 1e-8 units = cents × 1e6
```

Fixture control:

```text
283028776008n
```

which represents:

```text
$2,830.28776008
```

`list_amount` is a control/diagnostic value only.

The canonical monetary value remains `amount`.

---

### Gemini money

Raw Gemini:

```text
cost
```

is parsed from its exact raw JSON numeric lexeme.

Convert to:

```text
USD 1e-8 units
```

using exact decimal-string arithmetic.

No `Number` multiplication or floating-point summation is permitted.

The exported Gemini `cost` remains authoritative.

The pricing diagnostic does not alter reconciliation values.

---

## Claude Token Reconciliation

The following raw fields reconcile independently:

```text
uncached_input_tokens
cache_read_input_tokens
cache_creation.ephemeral_5m_input_tokens
cache_creation.ephemeral_1h_input_tokens
output_tokens
```

The canonical derived field:

```text
inputTotal
```

must satisfy:

```text
inputTotal
=
uncached input
+ cache-read input
+ 5m cache-creation input
+ 1h cache-creation input
```

Also:

```text
total_tokens
=
inputTotal + output
```

Do not sum `inputTotal` in addition to its four components.

That would double-count tokens.

Claude request counts reconcile only from usage observations.

Claude charge rows do not contribute requests.

---

## Gemini Reconciliation

Gemini tokens reconcile separately by:

```text
direction
model
```

Directions are:

```text
input
output
```

Each Gemini source row generates:

```text
one usage observation
+
one charge observation
```

for the same source row.

Reconciliation must ensure:

```text
resolved Gemini source rows
=
Gemini usage observations
=
Gemini charge observations
```

for accepted rows.

Gemini:

```text
requests
cache
web-search
```

remain `Unavailable`.

They are never converted to zero.

---

## Claude Usage / Cost Pairing

Pairing key:

```text
(
  user_id,
  starting_at,
  product,
  model
)
```

For accepted source rows:

1. Every Claude usage row has exactly one `tokens` charge.
2. Every Claude `tokens` charge has exactly one usage row.
3. Every `web_search` charge has exactly one usage row.
4. Every usage row with:

```text
web_search_requests > 0
```

has exactly one `web_search` charge. 5. A usage row with:

```text
web_search_requests = 0
```

requires no web-search charge. 6. Paired raw cost-row:

```text
requests
rbac_group_id
actor.email
```

must agree with its usage counterpart.

Pairing failures involving quarantined/conflicted rows are recorded as explained rather than generating misleading orphan errors.

If one required Claude source file fails entirely:

```text
Claude pairing = not_run
```

It is never reported as passing.

---

## Rollup Reconciliation

Required reconciliation buckets:

```text
platform × week
platform × group
platform × group × week
```

Use one reusable grouping mechanism with different key selectors.

Do not implement three unrelated rollup systems.

For each platform:

```text
sum(week buckets) = platform total
```

```text
sum(group buckets) = platform total
```

```text
sum(group × week buckets) = platform total
```

and:

```text
sum weeks for one group
=
platform × group total
```

```text
sum groups for one week
=
platform × week total
```

Every accepted observation belongs to exactly one group and one ISO week.

Raw buckets independently derive:

- user/group attribution from directory source data;
- UTC day;
- ISO week.

They must not trust the canonical observation's already-derived values.

Unresolved attribution belongs to an explicit raw:

```text
unattributed
```

control bucket.

It never becomes a canonical group.

---

## Gap Detection

Gap detection is:

```text
platform × day
```

only.

It does not run per user or per group.

A source gap means:

```text
no rows exist for that platform on a date
within the expected source window
```

A group having no activity on a day is **not** a source gap.

Gap detection:

- is generic;
- may accept an explicit expected date range;
- reports gaps as warnings;
- never synthesizes zero observations.

Fixture expectation:

```text
Claude: 56 source days, no gaps
Gemini: 55 source days
Gemini missing date: 2026-08-23
```

The date itself is a test fixture expectation, not production business logic.

---

## Reconciliation Check Result

Every reconciliation check returns one of:

```text
pass
fail
not_run
```

### `pass`

The invariant was evaluated and satisfied.

### `fail`

The invariant was evaluated and violated.

Examples:

```text
money delta != 0
token delta != 0
rollup delta != 0
duplicate active observation
unexpected pairing mismatch
```

### `not_run`

The invariant could not be evaluated because required source data was unavailable.

Example:

```text
Claude usage file failed
→ Claude usage/cost pairing = not_run
```

`not_run` must never be reported as `pass`.

---

## Run Status Semantics

Exactly one overall status is produced.

### `blocked`

Directory artifact failed.

Behaviour:

- no attribution occurs;
- no source ingestion proceeds;
- no observations are produced.

---

### `partial`

Directory is valid, but at least one source artifact has a file-level failure.

Other valid sources may still ingest.

Checks requiring the failed source are:

```text
not_run
```

---

### `complete_with_exclusions`

All expected source files parsed successfully, but at least one of the following exists:

```text
quarantined row
duplicate extra
conflict
restatement
```

All fatal reconciliation checks that are applicable must still pass.

Warnings are allowed.

---

### `complete`

All expected sources parsed successfully.

There are:

```text
no quarantined rows
no duplicate extras
no conflicts
no restatements
```

All applicable reconciliation checks are:

```text
pass
```

Warnings such as source-day gaps are allowed.

---

### `failed`

Source files were sufficiently processed to run reconciliation, but one or more fatal integrity checks returned:

```text
fail
```

Examples:

```text
token unexplained delta != 0
money unexplained delta != 0
rollup delta != 0
unexpected duplicate active key
fatal Claude pairing inconsistency
row-accounting violation
```

A reconciliation failure can never result in:

```text
complete
```

or:

```text
complete_with_exclusions
```

Warnings and expected gaps do not cause `failed`.

---

## Determinism

For identical logical input:

```text
state
report
totals
dispositions
findings
```

must be deterministic.

The following must not change results:

```text
source artifact ordering
row ordering
host timezone
re-running identical artifacts
```

All report arrays must use stable sorting.

No clock or randomness may affect output.

---

## Invariants

1. Same source kind + same bytes produces the same artifact identity.

2. Every parseable source row has exactly one Step 2 outcome.

3. Every source row receives exactly one Step 3 disposition.

4. Only uniquely accepted, resolved rows contribute canonical observations.

5. Active source keys are unique.

6. Identical duplicate rows are counted once.

7. Conflicting same-key rows never select a winner based on order.

8. Prior-state restatements never silently replace the prior active row.

9. Absence from a new artifact never implies deletion.

10. Directory failure blocks ingestion.

11. Raw money reconciliation uses exact `bigint` arithmetic only.

12. Raw-vs-canonical token and money tolerance is exactly zero.

13. Raw controls are implemented independently of Step 2 normalization.

14. Claude requests come only from usage observations.

15. Gemini unavailable measures remain unavailable.

16. A source-level failure cannot produce a false reconciliation pass.

17. Each accepted observation belongs to exactly one reconciliation group/week bucket.

18. Quarantine retains no raw payload.

19. `starter-kit/` remains read-only.

20. Identical inputs produce deterministic output.

---

## Out of Scope

The following are explicitly not part of Step 3:

- SQLite;
- Drizzle;
- database schemas;
- database transactions;
- persistent tables;
- writing ingestion state to files;
- production restatement replacement policy;
- history storage;
- tombstones;
- queues;
- Kafka;
- workers;
- locks;
- concurrent-ingestion coordination;
- retries/backoff;
- scheduled ingestion;
- live Anthropic/GCP API fetching;
- authorization;
- Fastify API;
- MCP;
- React UI;
- `usage_summary`;
- `top_users`;
- environment provisioning;
- cross-platform reporting semantics beyond Step 3 controls.

---

## MUST-HAVE Acceptance Tests

### Artifact identity / fingerprints

**I1 — Artifact identity**

Given identical raw bytes:

```text
source kind + SHA
```

is identical across runs.

Changing one byte changes the artifact version.

---

**I2 — Source row keys**

Verify correct extraction for:

```text
Claude usage
Claude cost
Gemini billing
```

Keys do not use:

```text
cost
export_time
invoice.month
```

---

**I3 — Missing key**

A row lacking a required key component:

```text
→ quarantined
→ SourceRef retained
→ no deduplication attempted
```

---

**I4 — Fingerprint determinism**

JSON key-order and insignificant whitespace changes:

```text
→ same fingerprint
```

Numeric-lexeme change:

```text
0.107564
vs
0.1075640
```

produces different fingerprints.

---

## Duplicate / Conflict Tests

**D1 — Identical duplicate**

Insert the same source row twice.

Expected:

```text
one accepted
one duplicate
totals counted once
```

---

**D2 — Conflicting duplicate**

Same source key but different token/cost value.

Expected:

```text
both/all versions → conflict
none contribute
```

---

**D3 — Three-way conflict**

Three distinct fingerprints under the same source key.

Expected:

```text
all excluded
```

No ordering-based winner.

---

**D4 — Conflict involving invalid row**

One valid row and one rejected row share a source key but have different fingerprints.

Expected:

```text
source-key group = conflict
neither contributes
```

---

## Restatement / Replay Tests

**R1 — Exact replay**

Ingest the same artifacts twice.

Expected:

```text
same active state
same totals
same deterministic report
no duplicate contribution
```

---

**R2 — Row order**

Shuffle rows.

Expected:

```text
same totals
same active keys
same conflict decisions
```

---

**R3 — Artifact order**

Change ingestion order:

```text
Claude usage
Claude cost
Gemini
```

versus another order.

Expected:

```text
identical final state/report
```

---

**R4 — Restatement**

Prior state contains source key `K`.

New artifact contains:

```text
same K
different fingerprint
```

Expected:

```text
prior remains active
new row → restatement
new value does not affect totals
status = complete_with_exclusions
```

---

**R5 — Missing prior row**

A newer artifact omits a previously active source key.

Expected:

```text
prior value remains active
no deletion
```

---

## File-Level Failure Tests

**F1 — Directory failure**

Malformed directory.

Expected:

```text
status = blocked
zero observations
```

---

**F2 — Claude source failure**

Malformed Claude usage file.

Expected:

```text
status = partial
other valid sources may process
Claude pairing = not_run
```

---

**F3 — Gemini truncated JSONL**

A torn JSONL line.

Expected:

```text
Gemini source failure
status = partial
Gemini-dependent checks = not_run
```

---

## Reconciliation Tests

**X1 — Claude money**

Fixture raw Claude cost equals:

```text
283028776008n
```

in USD 1e-8 units.

Canonical total matches exactly.

```text
unexplained delta = 0n
```

---

**X2 — Claude token fields**

Independently reconcile:

```text
uncached_input
cache_read_input
cache_creation_5m_input
cache_creation_1h_input
output
```

Also prove:

```text
Σ total_tokens
=
Σ (inputTotal + output)
```

---

**X3 — Gemini money**

Independent raw Gemini cost total equals canonical charge total exactly.

No floating point.

---

**X4 — Gemini tokens**

Reconcile:

```text
direction × model
```

with exact token totals.

---

**X5 — Claude pairing**

Fixture expectations:

```text
1346 usage rows
1346 tokens charges
492 web_search charges
```

Every expected pair exists exactly once.

No unexplained orphans.

Raw paired:

```text
requests
rbac_group_id
actor.email
```

agree.

---

**X6 — Explained exclusion**

Create an unresolved but otherwise measurable row.

Expected:

```text
raw
=
canonical
+ explained exclusion
```

and:

```text
unexplained = 0
```

---

**X7 — Money tamper**

Change one canonical monetary value by:

```text
1n
```

Expected:

```text
reconciliation = fail
run status = failed
```

---

**X8 — Token tamper**

Change one canonical token quantity by:

```text
1
```

Expected:

```text
reconciliation = fail
run status = failed
```

---

**X9 — Unmeasurable exclusion**

Excluded row contains an independently unparseable measure.

Expected:

```text
measure = unmeasurable
bucket cannot claim exact reconciliation
reconciliation check = fail
run status = failed
```

---

**X10 — Raw-control independence**

Raw-control implementation must not import Step 2:

```text
money parsing
attribution
normalization
```

Enforce through an import-boundary test or equivalent focused test.

---

## Rollup Tests

**P1 — Platform × week**

For each platform:

```text
sum(all weeks)
=
platform control total
```

for supported measures.

---

**P2 — Platform × group**

```text
sum(all groups)
=
platform control total
```

---

**P3 — Platform × group × week**

Verify:

```text
sum weeks for group
=
platform × group
```

```text
sum groups for week
=
platform × week
```

```text
sum all cells
=
platform control total
```

Every accepted observation appears in exactly one cell.

---

**P4 — One-unit rollup corruption**

Tamper one rollup value.

Expected:

```text
reconciliation check = fail
status = failed
```

---

## Gap Tests

**G1 — Generic gap detection**

Synthetic platform date sequences with:

```text
no gap
one gap
multiple gaps
```

produce the expected warnings.

---

**G2 — Fixture coverage**

Expected:

```text
Claude source days = 56
Claude gaps = none

Gemini source days = 55
Gemini only gap = 2026-08-23
```

The gap is a warning.

It does not create a zero observation.

It does not prevent:

```text
status = complete
```

for the clean supplied fixture.

---

## Run Status Tests

**S1**

Directory failure:

```text
blocked
```

---

**S2**

Source file failure:

```text
partial
```

---

**S3**

Row quarantine / duplicate / conflict / restatement with otherwise successful reconciliation:

```text
complete_with_exclusions
```

---

**S4**

Supplied fixture:

```text
complete
```

with zero quarantine, duplicate, conflict or restatement.

Gap warnings are permitted.

---

**S5**

Fatal reconciliation failure:

```text
failed
```

The run must never remain `complete` after a failed integrity check.

---

## Determinism Tests

Run the same inputs:

- repeatedly;
- shuffled;
- with artifacts reordered;
- under different host timezones.

Expected:

```text
same state
same totals
same dispositions
same report ordering
```

Required timezone runs:

```text
TZ=America/Toronto
TZ=Asia/Kolkata
```

---

## Fixture Safety

Hash all supplied starter-kit files before and after testing.

Expected:

```text
all hashes unchanged
```

No Step 3 code may modify `starter-kit/`.

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

All must pass before Task 003 is considered complete.
