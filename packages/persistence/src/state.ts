import {
  UNAVAILABLE,
  isoWeekOf,
  knownCount,
  parseGroupId,
  parseIsoWeek,
  parseModelName,
  parseProductName,
  parseUtcDay,
  parseUserId,
  parseWorkloadName,
  type ChargeObservation,
  type Count,
  type GroupId,
  type IsoWeek,
  type Money,
  type Result,
  type UtcDay,
  type UserId,
  type UsageObservation,
} from '@meridian/domain';
import type { ActiveRow, IngestionState, SourceArtifact } from '../../ingestion/src/index.js';
import { EMPTY_STATE } from '../../ingestion/src/index.js';
import type { PersistenceDatabase } from './db.js';
import type { PersistenceError } from './errors.js';

export const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const SOURCE_ORDER: readonly SourceArtifact['source'][] = [
  'directory',
  'claude_usage',
  'claude_cost',
  'gemini_billing',
] as const;

interface SourceArtifactRow {
  readonly source: string;
  readonly sha256: string;
  readonly byte_length: bigint;
}

interface ActiveSourceRowRecord {
  readonly key_digest: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly artifact_sha256: string;
  readonly directory_sha256: string;
  readonly row_index: bigint;
}

interface UsageObservationRow {
  readonly key_digest: string;
  readonly ordinal: bigint;
  readonly platform: string;
  readonly user_id: string;
  readonly group_id: string;
  readonly period_day: string;
  readonly iso_week: string;
  readonly model: string;
  readonly dimension_kind: string;
  readonly dimension_name: string;
  readonly uncached_input: bigint | null;
  readonly cache_read_input: bigint | null;
  readonly cache_creation_5m_input: bigint | null;
  readonly cache_creation_1h_input: bigint | null;
  readonly output: bigint | null;
  readonly input_total: bigint | null;
  readonly requests_count: bigint | null;
  readonly web_search_requests_count: bigint | null;
  readonly direction: string | null;
  readonly tokens: bigint | null;
}

interface ChargeObservationRow {
  readonly key_digest: string;
  readonly ordinal: bigint;
  readonly platform: string;
  readonly user_id: string;
  readonly group_id: string;
  readonly period_day: string;
  readonly iso_week: string;
  readonly model: string;
  readonly dimension_kind: string;
  readonly dimension_name: string;
  readonly charge_kind: string | null;
  readonly direction: string | null;
  readonly amount_usd_e8: bigint;
}

export interface AggregateTotals {
  readonly activeRows: number;
  readonly usageRows: number;
  readonly chargeRows: number;
  readonly tokenTotalsByPlatform: Readonly<Record<'claude' | 'gemini', bigint>>;
  readonly moneyTotalsByPlatform: Readonly<Record<'claude' | 'gemini', bigint>>;
}

function fail<T>(error: PersistenceError): Result<T, PersistenceError> {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T, PersistenceError> {
  return { ok: true, value };
}

function toSafeNumber(value: bigint, label: string): Result<number, PersistenceError> {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail({ kind: 'integrity_error', message: `${label} is outside JS safe integer range` });
  }
  return ok(Number(value));
}

export function validateMoney(amount: bigint): Result<Money, PersistenceError> {
  if (amount < 0n || amount > SQLITE_INT64_MAX) {
    return fail({ kind: 'money_out_of_range', amount });
  }
  return ok(amount);
}

function parseRowSourceKind(
  raw: string,
): Result<'claude_usage' | 'claude_cost' | 'gemini_billing', PersistenceError> {
  switch (raw) {
    case 'claude_usage':
    case 'claude_cost':
    case 'gemini_billing':
      return ok(raw);
    default:
      return fail({ kind: 'integrity_error', message: `unknown row source ${raw}` });
  }
}

function parseSourceKind(raw: string): Result<SourceArtifact['source'], PersistenceError> {
  switch (raw) {
    case 'directory':
    case 'claude_usage':
    case 'claude_cost':
    case 'gemini_billing':
      return ok(raw);
    default:
      return fail({ kind: 'integrity_error', message: `unknown source ${raw}` });
  }
}

function parsePeriod(
  periodDay: string,
  isoWeek: string,
): Result<{ readonly period: UtcDay; readonly week: IsoWeek }, PersistenceError> {
  const period = parseUtcDay(periodDay);
  if (!period.ok) {
    return fail({ kind: 'integrity_error', message: period.error });
  }
  const week = parseIsoWeek(isoWeek);
  if (!week.ok) {
    return fail({ kind: 'integrity_error', message: week.error });
  }
  if (isoWeekOf(period.value) !== week.value) {
    return fail({ kind: 'integrity_error', message: `iso week mismatch for ${periodDay}` });
  }
  return ok({ period: period.value, week: week.value });
}

function parseIds(
  userIdRaw: string,
  groupIdRaw: string,
): Result<{ readonly userId: UserId; readonly groupId: GroupId }, PersistenceError> {
  const userId = parseUserId(userIdRaw);
  if (!userId.ok) {
    return fail({ kind: 'integrity_error', message: userId.error });
  }
  const groupId = parseGroupId(groupIdRaw);
  if (!groupId.ok) {
    return fail({ kind: 'integrity_error', message: groupId.error });
  }
  return ok({ userId: userId.value, groupId: groupId.value });
}

function countFromBigInt(value: bigint, label: string): Result<Count, PersistenceError> {
  const safe = toSafeNumber(value, label);
  if (!safe.ok) {
    return safe;
  }
  const count = knownCount(safe.value);
  if (!count.ok) {
    return fail({ kind: 'integrity_error', message: count.error });
  }
  return ok(count.value);
}

function parseUsageObservation(
  row: UsageObservationRow,
): Result<UsageObservation, PersistenceError> {
  const ids = parseIds(row.user_id, row.group_id);
  if (!ids.ok) {
    return ids;
  }
  const period = parsePeriod(row.period_day, row.iso_week);
  if (!period.ok) {
    return period;
  }
  const model = parseModelName(row.model);
  if (!model.ok) {
    return fail({ kind: 'integrity_error', message: model.error });
  }

  if (row.platform === 'claude') {
    const dimension = parseProductName(row.dimension_name);
    if (!dimension.ok) {
      return fail({ kind: 'integrity_error', message: dimension.error });
    }
    if (
      row.dimension_kind !== 'product' ||
      row.uncached_input === null ||
      row.cache_read_input === null ||
      row.cache_creation_5m_input === null ||
      row.cache_creation_1h_input === null ||
      row.output === null ||
      row.input_total === null ||
      row.requests_count === null ||
      row.web_search_requests_count === null
    ) {
      return fail({ kind: 'integrity_error', message: 'invalid Claude usage row shape' });
    }
    const uncachedInput = toSafeNumber(row.uncached_input, 'uncached_input');
    const cacheReadInput = toSafeNumber(row.cache_read_input, 'cache_read_input');
    const cacheCreation5mInput = toSafeNumber(
      row.cache_creation_5m_input,
      'cache_creation_5m_input',
    );
    const cacheCreation1hInput = toSafeNumber(
      row.cache_creation_1h_input,
      'cache_creation_1h_input',
    );
    const output = toSafeNumber(row.output, 'output');
    const inputTotal = toSafeNumber(row.input_total, 'input_total');
    const requests = countFromBigInt(row.requests_count, 'requests_count');
    const webSearchRequests = countFromBigInt(
      row.web_search_requests_count,
      'web_search_requests_count',
    );
    if (!uncachedInput.ok) return uncachedInput;
    if (!cacheReadInput.ok) return cacheReadInput;
    if (!cacheCreation5mInput.ok) return cacheCreation5mInput;
    if (!cacheCreation1hInput.ok) return cacheCreation1hInput;
    if (!output.ok) return output;
    if (!inputTotal.ok) return inputTotal;
    if (!requests.ok) return requests;
    if (!webSearchRequests.ok) return webSearchRequests;
    return ok({
      platform: 'claude',
      kind: 'usage',
      userId: ids.value.userId,
      groupId: ids.value.groupId,
      period: period.value.period,
      model: model.value,
      dimension: { kind: 'product', name: dimension.value },
      uncachedInput: uncachedInput.value,
      cacheReadInput: cacheReadInput.value,
      cacheCreation5mInput: cacheCreation5mInput.value,
      cacheCreation1hInput: cacheCreation1hInput.value,
      output: output.value,
      inputTotal: inputTotal.value,
      requests: requests.value,
      webSearchRequests: webSearchRequests.value,
    });
  }

  if (
    row.platform !== 'gemini' ||
    row.dimension_kind !== 'workload' ||
    row.direction === null ||
    row.tokens === null
  ) {
    return fail({ kind: 'integrity_error', message: 'invalid Gemini usage row shape' });
  }
  if (row.direction !== 'input' && row.direction !== 'output') {
    return fail({ kind: 'integrity_error', message: `unknown token direction ${row.direction}` });
  }
  const dimension = parseWorkloadName(row.dimension_name);
  if (!dimension.ok) {
    return fail({ kind: 'integrity_error', message: dimension.error });
  }
  const tokens = countFromBigInt(row.tokens, 'tokens');
  if (!tokens.ok) {
    return tokens;
  }
  return ok({
    platform: 'gemini',
    kind: 'usage',
    userId: ids.value.userId,
    groupId: ids.value.groupId,
    period: period.value.period,
    model: model.value,
    dimension: { kind: 'workload', name: dimension.value },
    direction: row.direction,
    tokens: tokens.value,
    requests: UNAVAILABLE,
    cache: UNAVAILABLE,
    webSearch: UNAVAILABLE,
  });
}

function parseChargeObservation(
  row: ChargeObservationRow,
): Result<ChargeObservation, PersistenceError> {
  const ids = parseIds(row.user_id, row.group_id);
  if (!ids.ok) {
    return ids;
  }
  const period = parsePeriod(row.period_day, row.iso_week);
  if (!period.ok) {
    return period;
  }
  const model = parseModelName(row.model);
  if (!model.ok) {
    return fail({ kind: 'integrity_error', message: model.error });
  }
  const amount = validateMoney(row.amount_usd_e8);
  if (!amount.ok) {
    return amount;
  }

  if (row.platform === 'claude') {
    const dimension = parseProductName(row.dimension_name);
    if (!dimension.ok) {
      return fail({ kind: 'integrity_error', message: dimension.error });
    }
    if (
      row.dimension_kind !== 'product' ||
      (row.charge_kind !== 'tokens' && row.charge_kind !== 'web_search') ||
      row.direction !== null
    ) {
      return fail({ kind: 'integrity_error', message: 'invalid Claude charge row shape' });
    }
    return ok({
      platform: 'claude',
      kind: 'charge',
      userId: ids.value.userId,
      groupId: ids.value.groupId,
      period: period.value.period,
      model: model.value,
      dimension: { kind: 'product', name: dimension.value },
      chargeKind: row.charge_kind,
      amount: amount.value,
    });
  }

  if (
    row.platform !== 'gemini' ||
    row.dimension_kind !== 'workload' ||
    row.charge_kind !== null ||
    (row.direction !== 'input' && row.direction !== 'output')
  ) {
    return fail({ kind: 'integrity_error', message: 'invalid Gemini charge row shape' });
  }
  const dimension = parseWorkloadName(row.dimension_name);
  if (!dimension.ok) {
    return fail({ kind: 'integrity_error', message: dimension.error });
  }
  return ok({
    platform: 'gemini',
    kind: 'charge',
    userId: ids.value.userId,
    groupId: ids.value.groupId,
    period: period.value.period,
    model: model.value,
    dimension: { kind: 'workload', name: dimension.value },
    direction: row.direction,
    amount: amount.value,
  });
}

export function aggregateState(state: IngestionState): AggregateTotals {
  let usageRows = 0;
  let chargeRows = 0;
  let claudeTokens = 0n;
  let geminiTokens = 0n;
  let claudeMoney = 0n;
  let geminiMoney = 0n;

  for (const row of state.active.values()) {
    for (const observation of row.observations) {
      if (observation.kind === 'usage') {
        usageRows += 1;
        if (observation.platform === 'claude') {
          claudeTokens += BigInt(observation.inputTotal + observation.output);
        } else if (observation.tokens.kind === 'known') {
          geminiTokens += BigInt(observation.tokens.value);
        }
      } else {
        chargeRows += 1;
        if (observation.platform === 'claude') {
          claudeMoney += observation.amount;
        } else {
          geminiMoney += observation.amount;
        }
      }
    }
  }

  return {
    activeRows: state.active.size,
    usageRows,
    chargeRows,
    tokenTotalsByPlatform: { claude: claudeTokens, gemini: geminiTokens },
    moneyTotalsByPlatform: { claude: claudeMoney, gemini: geminiMoney },
  };
}

export function ensureAllMoneyFitsSqliteInt64(
  state: IngestionState,
): Result<void, PersistenceError> {
  for (const row of state.active.values()) {
    for (const observation of row.observations) {
      if (observation.kind !== 'charge') {
        continue;
      }
      const amount = validateMoney(observation.amount);
      if (!amount.ok) {
        return amount;
      }
    }
  }
  return ok(undefined);
}

export function loadPriorState(
  database: PersistenceDatabase,
): Result<IngestionState, PersistenceError> {
  const artifactRows = database.sqlite
    .prepare<[], SourceArtifactRow>(
      'select source, sha256, byte_length from source_artifacts order by source, sha256',
    )
    .all();
  const artifacts: SourceArtifact[] = [];
  for (const row of artifactRows) {
    const source = parseSourceKind(row.source);
    if (!source.ok) {
      return source;
    }
    const byteLength = toSafeNumber(row.byte_length, 'source_artifacts.byte_length');
    if (!byteLength.ok) {
      return byteLength;
    }
    artifacts.push({ source: source.value, sha256: row.sha256, byteLength: byteLength.value });
  }
  artifacts.sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.sha256.localeCompare(b.sha256),
  );

  const activeRows = database.sqlite
    .prepare<[], ActiveSourceRowRecord>(
      'select key_digest, source, fingerprint, artifact_sha256, directory_sha256, row_index from active_source_rows order by key_digest',
    )
    .all();
  const usageRows = database.sqlite
    .prepare<[], UsageObservationRow>(
      'select key_digest, ordinal, platform, user_id, group_id, period_day, iso_week, model, dimension_kind, dimension_name, uncached_input, cache_read_input, cache_creation_5m_input, cache_creation_1h_input, output, input_total, requests_count, web_search_requests_count, direction, tokens from usage_observations order by key_digest, ordinal',
    )
    .all();
  const chargeRows = database.sqlite
    .prepare<[], ChargeObservationRow>(
      'select key_digest, ordinal, platform, user_id, group_id, period_day, iso_week, model, dimension_kind, dimension_name, charge_kind, direction, amount_usd_e8 from charge_observations order by key_digest, ordinal',
    )
    .all();

  const usageByKey = new Map<string, UsageObservation[]>();
  for (const row of usageRows) {
    const observation = parseUsageObservation(row);
    if (!observation.ok) {
      return observation;
    }
    usageByKey.set(row.key_digest, [...(usageByKey.get(row.key_digest) ?? []), observation.value]);
  }
  const chargeByKey = new Map<string, ChargeObservation[]>();
  for (const row of chargeRows) {
    const observation = parseChargeObservation(row);
    if (!observation.ok) {
      return observation;
    }
    chargeByKey.set(row.key_digest, [
      ...(chargeByKey.get(row.key_digest) ?? []),
      observation.value,
    ]);
  }

  const active = new Map<string, ActiveRow>();
  for (const row of activeRows) {
    const source = parseRowSourceKind(row.source);
    if (!source.ok) {
      return source;
    }
    const rowIndex = toSafeNumber(row.row_index, 'active_source_rows.row_index');
    if (!rowIndex.ok) {
      return rowIndex;
    }
    active.set(row.key_digest, {
      keyDigest: row.key_digest,
      source: source.value,
      fingerprint: row.fingerprint,
      artifactSha256: row.artifact_sha256,
      directorySha256: row.directory_sha256,
      ref: { source: source.value, rowIndex: rowIndex.value },
      observations: [
        ...(usageByKey.get(row.key_digest) ?? []),
        ...(chargeByKey.get(row.key_digest) ?? []),
      ],
    });
  }

  return ok(active.size === 0 && artifacts.length === 0 ? EMPTY_STATE : { active, artifacts });
}

export function verifyPersistedState(
  database: PersistenceDatabase,
  expected: IngestionState,
): Result<AggregateTotals, PersistenceError> {
  const reloaded = loadPriorState(database);
  if (!reloaded.ok) {
    return reloaded;
  }
  const actualTotals = aggregateState(reloaded.value);
  const expectedTotals = aggregateState(expected);
  const matches =
    actualTotals.activeRows === expectedTotals.activeRows &&
    actualTotals.usageRows === expectedTotals.usageRows &&
    actualTotals.chargeRows === expectedTotals.chargeRows &&
    actualTotals.tokenTotalsByPlatform.claude === expectedTotals.tokenTotalsByPlatform.claude &&
    actualTotals.tokenTotalsByPlatform.gemini === expectedTotals.tokenTotalsByPlatform.gemini &&
    actualTotals.moneyTotalsByPlatform.claude === expectedTotals.moneyTotalsByPlatform.claude &&
    actualTotals.moneyTotalsByPlatform.gemini === expectedTotals.moneyTotalsByPlatform.gemini;

  if (!matches) {
    return fail({
      kind: 'write_verification_failed',
      message: 'persisted state did not match trusted ingestion state',
    });
  }
  return ok(actualTotals);
}
