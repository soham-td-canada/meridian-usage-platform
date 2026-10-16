import { fail, ok, type Result } from '@meridian/domain';
import type { PersistenceDatabase } from './db.js';

export type UsagePlatform = 'claude' | 'gemini';

export type UsageQueryError =
  | { readonly kind: 'no_ingestion_run' }
  | { readonly kind: 'cost_incomplete' }
  | { readonly kind: 'malformed_row' }
  | { readonly kind: 'sqlite_error'; readonly message: string };

export interface UsageWindow {
  readonly groupId: string;
  /** Inclusive UTC day key `YYYY-MM-DD`. */
  readonly startDay: string;
  /** Exclusive UTC day key `YYYY-MM-DD`. */
  readonly endExclusiveDay: string;
}

export interface PlatformUsageAggregate {
  readonly platform: UsagePlatform;
  /** Null when the platform does not report request counts (Gemini billing). */
  readonly requests: bigint | null;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  /** Exact 1e-8 USD units. */
  readonly costE8: bigint;
}

export interface UserUsageAggregate {
  readonly userId: string;
  readonly name: string;
  readonly totalTokens: bigint;
  readonly costE8: bigint;
}

type SqlRow = Readonly<Record<string, unknown>>;

const PLATFORM_ORDER: readonly UsagePlatform[] = ['claude', 'gemini'];

const INPUT_TOKENS_SQL = `SUM(CASE WHEN platform = 'claude' THEN input_total
  WHEN direction = 'input' THEN tokens ELSE 0 END)`;
const OUTPUT_TOKENS_SQL = `SUM(CASE WHEN platform = 'claude' THEN output
  WHEN direction = 'output' THEN tokens ELSE 0 END)`;
const TOTAL_TOKENS_SQL = `SUM(CASE WHEN platform = 'claude' THEN input_total + output ELSE tokens END)`;

function bigintOf(value: unknown): bigint | undefined {
  return typeof value === 'bigint' ? value : undefined;
}

function platformOf(value: unknown): UsagePlatform | undefined {
  return PLATFORM_ORDER.find((candidate) => candidate === value);
}

function sqliteFailure(error: unknown): Result<never, UsageQueryError> {
  return fail({
    kind: 'sqlite_error',
    message: error instanceof Error ? error.message : 'unknown sqlite failure',
  });
}

export function hasIngestionRun(database: PersistenceDatabase): Result<boolean, UsageQueryError> {
  try {
    const row = database.sqlite
      .prepare<[], SqlRow>('SELECT COUNT(*) AS n FROM ingestion_runs')
      .get();
    const count = bigintOf(row?.['n']);
    return count === undefined ? fail({ kind: 'malformed_row' }) : ok(count > 0n);
  } catch (error: unknown) {
    return sqliteFailure(error);
  }
}

/** Per-platform aggregates for one group over `[startDay, endExclusiveDay)`. Absent platforms are omitted. */
export function aggregateGroupUsage(
  database: PersistenceDatabase,
  window: UsageWindow,
): Result<readonly PlatformUsageAggregate[], UsageQueryError> {
  const params = [window.groupId, window.startDay, window.endExclusiveDay] as const;
  try {
    const usageRows = database.sqlite
      .prepare<[string, string, string], SqlRow>(
        `SELECT platform, SUM(requests_count) AS requests,
           ${INPUT_TOKENS_SQL} AS input_tokens, ${OUTPUT_TOKENS_SQL} AS output_tokens
         FROM usage_observations
         WHERE group_id = ? AND period_day >= ? AND period_day < ?
         GROUP BY platform`,
      )
      .all(...params);
    const chargeRows = database.sqlite
      .prepare<[string, string, string], SqlRow>(
        `SELECT platform, SUM(amount_usd_e8) AS cost
         FROM charge_observations
         WHERE group_id = ? AND period_day >= ? AND period_day < ?
         GROUP BY platform`,
      )
      .all(...params);

    const costs = new Map<UsagePlatform, bigint>();
    for (const row of chargeRows) {
      const platform = platformOf(row['platform']);
      const cost = bigintOf(row['cost']);
      if (platform === undefined || cost === undefined) {
        return fail({ kind: 'malformed_row' });
      }
      costs.set(platform, cost);
    }

    const aggregates = new Map<UsagePlatform, PlatformUsageAggregate>();
    for (const row of usageRows) {
      const platform = platformOf(row['platform']);
      const inputTokens = bigintOf(row['input_tokens']);
      const outputTokens = bigintOf(row['output_tokens']);
      const requests = row['requests'] === null ? null : bigintOf(row['requests']);
      const costE8 = platform === undefined ? undefined : costs.get(platform);
      if (platform === undefined || inputTokens === undefined || outputTokens === undefined) {
        return fail({ kind: 'malformed_row' });
      }
      if (requests === undefined) {
        return fail({ kind: 'malformed_row' });
      }
      if (costE8 === undefined) {
        return fail({ kind: 'cost_incomplete' });
      }
      aggregates.set(platform, { platform, requests, inputTokens, outputTokens, costE8 });
    }
    if (costs.size !== aggregates.size) {
      return fail({ kind: 'cost_incomplete' });
    }
    return ok(
      PLATFORM_ORDER.flatMap((platform) => {
        const aggregate = aggregates.get(platform);
        return aggregate === undefined ? [] : [aggregate];
      }),
    );
  } catch (error: unknown) {
    return sqliteFailure(error);
  }
}

/** Per-user totals for one group over `[startDay, endExclusiveDay)`, ranked by tokens desc then user id. */
export function rankGroupUsers(
  database: PersistenceDatabase,
  window: UsageWindow,
): Result<readonly UserUsageAggregate[], UsageQueryError> {
  const params = [window.groupId, window.startDay, window.endExclusiveDay] as const;
  try {
    const usageRows = database.sqlite
      .prepare<[string, string, string], SqlRow>(
        `SELECT o.user_id AS user_id, u.name AS name, ${TOTAL_TOKENS_SQL} AS tokens
         FROM usage_observations o JOIN users u ON u.user_id = o.user_id
         WHERE o.group_id = ? AND o.period_day >= ? AND o.period_day < ?
         GROUP BY o.user_id, u.name`,
      )
      .all(...params);
    const chargeRows = database.sqlite
      .prepare<[string, string, string], SqlRow>(
        `SELECT user_id, SUM(amount_usd_e8) AS cost
         FROM charge_observations
         WHERE group_id = ? AND period_day >= ? AND period_day < ?
         GROUP BY user_id`,
      )
      .all(...params);

    const costs = new Map<string, bigint>();
    for (const row of chargeRows) {
      const userId = row['user_id'];
      const cost = bigintOf(row['cost']);
      if (typeof userId !== 'string' || cost === undefined) {
        return fail({ kind: 'malformed_row' });
      }
      costs.set(userId, cost);
    }

    const users: UserUsageAggregate[] = [];
    for (const row of usageRows) {
      const userId = row['user_id'];
      const name = row['name'];
      const totalTokens = bigintOf(row['tokens']);
      if (typeof userId !== 'string' || typeof name !== 'string' || totalTokens === undefined) {
        return fail({ kind: 'malformed_row' });
      }
      const costE8 = costs.get(userId);
      if (costE8 === undefined) {
        return fail({ kind: 'cost_incomplete' });
      }
      users.push({ userId, name, totalTokens, costE8 });
    }
    if (costs.size !== users.length) {
      return fail({ kind: 'cost_incomplete' });
    }
    users.sort((a, b) => {
      if (a.totalTokens !== b.totalTokens) {
        return a.totalTokens > b.totalTokens ? -1 : 1;
      }
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });
    return ok(users);
  } catch (error: unknown) {
    return sqliteFailure(error);
  }
}
