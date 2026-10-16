import {
  isoWeekOf,
  type Directory,
  type DirectoryGroup,
  type DirectoryUser,
  type Result,
} from '@meridian/domain';
import {
  directoryArtifactOf,
  ingest,
  loadDirectory,
  type ActiveRow,
  type IngestionResult,
  type RawArtifact,
  type ReportRow,
} from '../../ingestion/src/index.js';
import { applyMigrations, type PersistenceDatabase } from './db.js';
import type { PersistableRunStatus, PersistenceError } from './errors.js';
import { initializeCapabilityState } from './capability-repository.js';
import { drizzleRuntime as d } from './drizzle-runtime.js';
import { directorySnapshots, groups, sourceArtifacts, users } from './schema.js';
import { ensureAllMoneyFitsSqliteInt64, loadPriorState, verifyPersistedState } from './state.js';

export interface IngestAndPersistInput {
  readonly database: PersistenceDatabase;
  readonly artifacts: readonly RawArtifact[];
  readonly environment: string;
  readonly recordedAt: string;
}

export interface IngestAndPersistSuccess {
  readonly runId: bigint;
  readonly status: PersistableRunStatus;
  readonly result: IngestionResult;
  readonly persisted: {
    readonly activeRows: number;
    readonly usageRows: number;
    readonly chargeRows: number;
    readonly excludedRows: number;
    readonly capabilityRowsCreated: number;
  };
}

interface UsageInsertRow {
  readonly keyDigest: string;
  readonly ordinal: number;
  readonly platform: 'claude' | 'gemini';
  readonly userId: string;
  readonly groupId: string;
  readonly periodDay: string;
  readonly isoWeek: string;
  readonly model: string;
  readonly dimensionKind: 'product' | 'workload';
  readonly dimensionName: string;
  readonly uncachedInput: number | null;
  readonly cacheReadInput: number | null;
  readonly cacheCreation5mInput: number | null;
  readonly cacheCreation1hInput: number | null;
  readonly output: number | null;
  readonly inputTotal: number | null;
  readonly requestsCount: number | null;
  readonly webSearchRequestsCount: number | null;
  readonly direction: 'input' | 'output' | null;
  readonly tokens: number | null;
}

interface ChargeInsertRow {
  readonly keyDigest: string;
  readonly ordinal: number;
  readonly platform: 'claude' | 'gemini';
  readonly userId: string;
  readonly groupId: string;
  readonly periodDay: string;
  readonly isoWeek: string;
  readonly model: string;
  readonly dimensionKind: 'product' | 'workload';
  readonly dimensionName: string;
  readonly chargeKind: 'tokens' | 'web_search' | null;
  readonly direction: 'input' | 'output' | null;
  readonly amountUsdE8: bigint;
}

function fail<T>(error: PersistenceError): Result<T, PersistenceError> {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T, PersistenceError> {
  return { ok: true, value };
}

function messageOf(error: PersistenceError): string {
  switch (error.kind) {
    case 'integrity_error':
    case 'sqlite_error':
    case 'write_verification_failed':
      return error.message;
    case 'money_out_of_range':
      return `money out of range: ${error.amount.toString()}`;
    case 'status_refused':
      return `status refused: ${error.status}`;
    case 'unknown_environment':
      return `unknown environment: ${error.environment}`;
    case 'config_group_missing':
      return `config group missing: ${error.groupId}`;
    case 'unknown_group':
      return `unknown group: ${error.groupId}`;
    case 'unknown_capability':
      return `unknown capability: ${error.capability}`;
    case 'state_missing':
      return `state missing: ${error.groupId}/${error.capability}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function loadDirectoryFromArtifacts(artifacts: readonly RawArtifact[]): Result<
  {
    readonly directory: Directory;
    readonly groups: readonly DirectoryGroup[];
    readonly users: readonly DirectoryUser[];
    readonly sha256: string;
  },
  PersistenceError
> {
  const artifact = artifacts.find((candidate) => candidate.source === 'directory');
  if (artifact === undefined) {
    return fail({ kind: 'integrity_error', message: 'directory artifact missing' });
  }
  const usersText = decodeUtf8(artifact.users);
  const groupsText = decodeUtf8(artifact.groups);
  if (usersText === undefined || groupsText === undefined) {
    return fail({ kind: 'integrity_error', message: 'directory artifact is not valid UTF-8' });
  }
  const loaded = loadDirectory(usersText, groupsText);
  if (!loaded.ok) {
    return fail({ kind: 'integrity_error', message: loaded.error });
  }
  return ok({
    directory: loaded.value,
    users: [...loaded.value.usersById.values()],
    groups: [...loaded.value.groupsById.values()],
    sha256: directoryArtifactOf(artifact.users, artifact.groups).sha256,
  });
}

function persistableStatus(
  status: IngestionResult['report']['status'],
): Result<PersistableRunStatus, PersistenceError> {
  switch (status) {
    case 'complete':
    case 'complete_with_exclusions':
      return ok(status);
    case 'blocked':
    case 'failed':
    case 'partial':
      return fail({ kind: 'status_refused', status });
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function reasonCodeOf(row: ReportRow): string | null {
  switch (row.disposition.kind) {
    case 'accepted':
      return null;
    case 'duplicate':
      return null;
    case 'conflict':
      return `distinct:${String(row.disposition.distinctFingerprints)}`;
    case 'restatement':
      return row.disposition.reason;
    case 'quarantined':
      return row.disposition.reason.kind === 'key_unextractable'
        ? row.disposition.reason.kind
        : `${row.disposition.reason.kind}:${row.disposition.reason.code}`;
    default: {
      const exhaustive: never = row.disposition;
      return exhaustive;
    }
  }
}

function serializeUsageObservation(
  keyDigest: string,
  observation: Extract<ActiveRow['observations'][number], { readonly kind: 'usage' }>,
  ordinal: number,
): Result<UsageInsertRow, PersistenceError> {
  if (observation.platform === 'claude') {
    if (observation.requests.kind !== 'known' || observation.webSearchRequests.kind !== 'known') {
      return fail({ kind: 'integrity_error', message: 'Claude usage counts must be known' });
    }
    return ok({
      keyDigest,
      ordinal,
      platform: 'claude',
      userId: observation.userId,
      groupId: observation.groupId,
      periodDay: observation.period,
      isoWeek: isoWeekOf(observation.period),
      model: observation.model,
      dimensionKind: 'product',
      dimensionName: observation.dimension.name,
      uncachedInput: observation.uncachedInput,
      cacheReadInput: observation.cacheReadInput,
      cacheCreation5mInput: observation.cacheCreation5mInput,
      cacheCreation1hInput: observation.cacheCreation1hInput,
      output: observation.output,
      inputTotal: observation.inputTotal,
      requestsCount: observation.requests.value,
      webSearchRequestsCount: observation.webSearchRequests.value,
      direction: null,
      tokens: null,
    });
  }
  if (observation.tokens.kind !== 'known') {
    return fail({ kind: 'integrity_error', message: 'Gemini usage tokens must be known' });
  }
  return ok({
    keyDigest,
    ordinal,
    platform: 'gemini',
    userId: observation.userId,
    groupId: observation.groupId,
    periodDay: observation.period,
    isoWeek: isoWeekOf(observation.period),
    model: observation.model,
    dimensionKind: 'workload',
    dimensionName: observation.dimension.name,
    uncachedInput: null,
    cacheReadInput: null,
    cacheCreation5mInput: null,
    cacheCreation1hInput: null,
    output: null,
    inputTotal: null,
    requestsCount: null,
    webSearchRequestsCount: null,
    direction: observation.direction,
    tokens: observation.tokens.value,
  });
}

function serializeChargeObservation(
  keyDigest: string,
  observation: Extract<ActiveRow['observations'][number], { readonly kind: 'charge' }>,
  ordinal: number,
): ChargeInsertRow {
  if (observation.platform === 'claude') {
    return {
      keyDigest,
      ordinal,
      platform: 'claude',
      userId: observation.userId,
      groupId: observation.groupId,
      periodDay: observation.period,
      isoWeek: isoWeekOf(observation.period),
      model: observation.model,
      dimensionKind: 'product',
      dimensionName: observation.dimension.name,
      chargeKind: observation.chargeKind,
      direction: null,
      amountUsdE8: observation.amount,
    };
  }
  return {
    keyDigest,
    ordinal,
    platform: 'gemini',
    userId: observation.userId,
    groupId: observation.groupId,
    periodDay: observation.period,
    isoWeek: isoWeekOf(observation.period),
    model: observation.model,
    dimensionKind: 'workload',
    dimensionName: observation.dimension.name,
    chargeKind: null,
    direction: observation.direction,
    amountUsdE8: observation.amount,
  };
}

function newActiveRows(
  prior: ReadonlyMap<string, ActiveRow>,
  next: ReadonlyMap<string, ActiveRow>,
): readonly ActiveRow[] {
  return [...next.entries()].filter(([keyDigest]) => !prior.has(keyDigest)).map(([, row]) => row);
}

function sqliteError(operation: string, error: unknown): PersistenceError {
  if (error instanceof Error) {
    return { kind: 'sqlite_error', operation, message: error.message };
  }
  return { kind: 'sqlite_error', operation, message: String(error) };
}

function insertArtifacts(database: PersistenceDatabase, result: IngestionResult): void {
  for (const artifact of result.state.artifacts) {
    database.orm
      .insert(sourceArtifacts)
      .values({
        source: artifact.source,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
      })
      .onConflictDoNothing()
      .run();
  }
}

function insertDirectorySnapshot(database: PersistenceDatabase, directorySha256: string): void {
  database.orm
    .insert(directorySnapshots)
    .values({ sha256: directorySha256, firstSeenRunId: null })
    .onConflictDoNothing()
    .run();
}

function insertDirectoryDimensions(
  database: PersistenceDatabase,
  directory: {
    readonly users: readonly DirectoryUser[];
    readonly groups: readonly DirectoryGroup[];
  },
): void {
  for (const user of directory.users) {
    database.orm
      .insert(users)
      .values({ userId: user.userId, name: user.name })
      .onConflictDoNothing()
      .run();
  }
  for (const group of directory.groups) {
    database.orm
      .insert(groups)
      .values({ groupId: group.groupId, name: group.name })
      .onConflictDoNothing()
      .run();
  }
}

function insertAcceptedRows(
  database: PersistenceDatabase,
  rows: readonly ActiveRow[],
): Result<void, PersistenceError> {
  const insertActive = database.sqlite.prepare(
    'insert into active_source_rows (key_digest, source, fingerprint, artifact_sha256, directory_sha256, row_index) values (?, ?, ?, ?, ?, ?) on conflict(key_digest) do nothing',
  );
  const insertUsage = database.sqlite.prepare(
    'insert into usage_observations (key_digest, ordinal, platform, user_id, group_id, period_day, iso_week, model, dimension_kind, dimension_name, uncached_input, cache_read_input, cache_creation_5m_input, cache_creation_1h_input, output, input_total, requests_count, web_search_requests_count, direction, tokens) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertCharge = database.sqlite.prepare(
    'insert into charge_observations (key_digest, ordinal, platform, user_id, group_id, period_day, iso_week, model, dimension_kind, dimension_name, charge_kind, direction, amount_usd_e8) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insertActive.run(
      row.keyDigest,
      row.source,
      row.fingerprint,
      row.artifactSha256,
      row.directorySha256,
      row.ref.rowIndex,
    );
    row.observations.forEach((observation: ActiveRow['observations'][number], ordinal: number) => {
      if (observation.kind === 'usage') {
        const usage = serializeUsageObservation(row.keyDigest, observation, ordinal);
        if (!usage.ok) {
          throw new Error(messageOf(usage.error));
        }
        insertUsage.run(
          usage.value.keyDigest,
          usage.value.ordinal,
          usage.value.platform,
          usage.value.userId,
          usage.value.groupId,
          usage.value.periodDay,
          usage.value.isoWeek,
          usage.value.model,
          usage.value.dimensionKind,
          usage.value.dimensionName,
          usage.value.uncachedInput,
          usage.value.cacheReadInput,
          usage.value.cacheCreation5mInput,
          usage.value.cacheCreation1hInput,
          usage.value.output,
          usage.value.inputTotal,
          usage.value.requestsCount,
          usage.value.webSearchRequestsCount,
          usage.value.direction,
          usage.value.tokens,
        );
        return;
      }
      const charge = serializeChargeObservation(row.keyDigest, observation, ordinal);
      insertCharge.run(
        charge.keyDigest,
        charge.ordinal,
        charge.platform,
        charge.userId,
        charge.groupId,
        charge.periodDay,
        charge.isoWeek,
        charge.model,
        charge.dimensionKind,
        charge.dimensionName,
        charge.chargeKind,
        charge.direction,
        charge.amountUsdE8,
      );
    });
  }
  return ok(undefined);
}

/**
 * Whether rows excluded from active state carried measurable token or money value, and whether any
 * platform-level delta was unmeasurable. Derived from Step 3's platform rollup checks.
 */
function exclusionIndicators(result: IngestionResult): {
  readonly tokens: boolean;
  readonly money: boolean;
  readonly unmeasurable: boolean;
} {
  let tokens = false;
  let money = false;
  let unmeasurable = false;
  for (const check of result.report.reconciliation.checks) {
    for (const delta of check.deltas) {
      if (delta.selector !== 'platform') {
        continue;
      }
      unmeasurable ||= delta.unmeasurable;
      if (check.id.endsWith('.platform.tokens')) {
        tokens ||= delta.excluded !== 0n;
      } else if (check.id.endsWith('.platform.money')) {
        money ||= delta.excluded !== 0n;
      }
    }
  }
  return { tokens, money, unmeasurable };
}

function insertRun(
  database: PersistenceDatabase,
  status: PersistableRunStatus,
  directorySha256: string,
  recordedAt: string,
  result: IngestionResult,
): bigint {
  const checksFailed = result.report.reconciliation.checks.filter(
    (check) => check.status === 'fail',
  ).length;
  const checksNotRun = result.report.reconciliation.checks.filter(
    (check) => check.status === 'not_run',
  ).length;
  const exclusions = exclusionIndicators(result);
  const insert = database.sqlite.prepare(
    'insert into ingestion_runs (status, directory_sha256, recorded_at, rows_total, accepted, replayed, duplicates, conflicts, restatements, quarantined, prior_keys_absent, checks_failed, checks_not_run, exclusions_affect_tokens, exclusions_affect_money, exclusions_unmeasurable) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const response = insert.run(
    status,
    directorySha256,
    recordedAt,
    result.report.counts.rows,
    result.report.counts.accepted,
    result.report.counts.replayed,
    result.report.counts.duplicates,
    result.report.counts.conflicts,
    result.report.counts.restatements,
    result.report.counts.quarantined,
    result.report.counts.priorKeysAbsent,
    checksFailed,
    checksNotRun,
    exclusions.tokens ? 1 : 0,
    exclusions.money ? 1 : 0,
    exclusions.unmeasurable ? 1 : 0,
  );
  return BigInt(response.lastInsertRowid);
}

function insertExcludedRows(
  database: PersistenceDatabase,
  runId: bigint,
  rows: readonly ReportRow[],
): void {
  const statement = database.sqlite.prepare(
    'insert into run_excluded_rows (run_id, source, artifact_sha256, row_index, key_digest, fingerprint, disposition, reason_code) values (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    statement.run(
      runId,
      row.provenance.source,
      row.provenance.artifactSha256,
      row.provenance.ref.rowIndex,
      row.provenance.keyDigest ?? null,
      row.provenance.fingerprint,
      row.disposition.kind,
      reasonCodeOf(row),
    );
  }
}

export function ingestAndPersist(
  input: IngestAndPersistInput,
): Result<IngestAndPersistSuccess, PersistenceError> {
  input.database.sqlite.exec('BEGIN IMMEDIATE');
  try {
    // DDL runs inside the transaction so a refused run on a fresh database rolls the schema back.
    applyMigrations(input.database);
    const prior = loadPriorState(input.database);
    if (!prior.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return prior;
    }
    const result = ingest(input.artifacts, prior.value);
    const status = persistableStatus(result.report.status);
    if (!status.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return status;
    }
    const directory = loadDirectoryFromArtifacts(input.artifacts);
    if (!directory.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return directory;
    }
    const moneyFits = ensureAllMoneyFitsSqliteInt64(result.state);
    if (!moneyFits.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return moneyFits;
    }

    const acceptedRows = newActiveRows(prior.value.active, result.state.active);
    if (acceptedRows.length !== result.report.counts.accepted) {
      input.database.sqlite.exec('ROLLBACK');
      return fail({
        kind: 'integrity_error',
        message: 'accepted row count did not match state diff',
      });
    }

    insertArtifacts(input.database, result);
    insertDirectorySnapshot(input.database, directory.value.sha256);
    insertDirectoryDimensions(input.database, directory.value);
    const insertedRows = insertAcceptedRows(input.database, acceptedRows);
    if (!insertedRows.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return insertedRows;
    }

    const runId = insertRun(
      input.database,
      status.value,
      directory.value.sha256,
      input.recordedAt,
      result,
    );
    input.database.orm
      .update(directorySnapshots)
      .set({ firstSeenRunId: runId })
      .where(
        d.and(
          d.eq(directorySnapshots.sha256, directory.value.sha256),
          d.isNull(directorySnapshots.firstSeenRunId),
        ),
      )
      .run();

    const excludedRows = result.report.rows.filter((row) => row.disposition.kind !== 'accepted');
    if (excludedRows.length > 0) {
      insertExcludedRows(input.database, runId, excludedRows);
    }

    const seeded = initializeCapabilityState(
      input.database,
      input.environment,
      directory.value.groups,
    );
    if (!seeded.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return seeded;
    }

    const verified = verifyPersistedState(input.database, result.state);
    if (!verified.ok) {
      input.database.sqlite.exec('ROLLBACK');
      return verified;
    }

    input.database.sqlite.exec('COMMIT');
    return ok({
      runId,
      status: status.value,
      result,
      persisted: {
        activeRows: verified.value.activeRows,
        usageRows: verified.value.usageRows,
        chargeRows: verified.value.chargeRows,
        excludedRows: excludedRows.length,
        capabilityRowsCreated: seeded.value.createdRows,
      },
    });
  } catch (error: unknown) {
    input.database.sqlite.exec('ROLLBACK');
    return fail(sqliteError('ingest_and_persist', error));
  }
}
