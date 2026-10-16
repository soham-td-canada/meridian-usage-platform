import {
  authorizeCapabilityWrite,
  authorizeRead,
  resolveActor,
  type CapabilityStateSnapshot,
  type Denial,
  type TrustedActor,
} from '../../../packages/authorization/src/index.js';
import {
  CAPABILITIES,
  parseCapability,
  type Directory,
  type GroupId,
} from '../../../packages/domain/src/index.js';
import {
  aggregateGroupUsage,
  hasIngestionRun,
  listCapabilityState,
  rankGroupUsers,
  setCapabilityState,
  type PersistenceDatabase,
  type PlatformUsageAggregate,
  type UsageQueryError,
} from '../../../packages/persistence/src/index.js';
import { resolvePeriod, type ResolvedPeriod } from './period.js';

export const TOOL_NAMES = [
  'usage_summary',
  'top_users',
  'capability_status',
  'set_capability',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const DEFAULT_TOP_USERS_LIMIT = 10;
export const MAX_TOP_USERS_LIMIT = 25;

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ToolErrorCode = 'unknown_tool' | 'invalid_input' | 'no_data' | 'data_unavailable';

export interface ToolError {
  readonly error: ToolErrorCode;
  readonly message: string;
}

export type ToolOutcome =
  | { readonly kind: 'ok'; readonly value: JsonValue }
  | { readonly kind: 'denied'; readonly denial: Denial }
  | { readonly kind: 'error'; readonly error: ToolError };

export interface ToolServiceContext {
  /** Raw environment name; the authorization engine fails closed on unknown values. */
  readonly environment: string;
  readonly directory: Directory;
  readonly database: PersistenceDatabase;
  readonly now: () => Date;
}

export interface ToolService {
  /** `trustedUserId` must come from server-side context, never from tool arguments. */
  invoke(trustedUserId: string, tool: string, args: unknown): ToolOutcome;
}

type Args = Readonly<Record<string, unknown>>;

const ALLOWED_ARGUMENTS: Readonly<Record<ToolName, readonly string[]>> = {
  usage_summary: ['group', 'period'],
  top_users: ['group', 'period', 'limit'],
  capability_status: ['group'],
  set_capability: ['group', 'capability', 'enabled'],
};

const MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  unknown_tool: 'The requested tool does not exist.',
  invalid_input: 'The tool arguments are invalid.',
  no_data: 'No usage data exists for the requested group and period.',
  data_unavailable: 'The requested data is unavailable.',
};

const failure = (code: ToolErrorCode): ToolOutcome => ({
  kind: 'error',
  error: { error: code, message: MESSAGES[code] },
});

export function parseToolName(raw: unknown): ToolName | undefined {
  return TOOL_NAMES.find((candidate) => candidate === raw);
}

function parseArguments(tool: ToolName, raw: unknown): Args | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const allowed = ALLOWED_ARGUMENTS[tool];
  const record: Args = { ...raw };
  return Object.keys(record).every((key) => allowed.includes(key)) ? record : undefined;
}

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) {
    return DEFAULT_TOP_USERS_LIMIT;
  }
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_TOP_USERS_LIMIT
    ? raw
    : undefined;
}

const MONEY_SCALE = 8;

/** Exact decimal rendering of 1e-8 USD units; the float is parsed from text, never computed. */
function usdNumberOf(units: bigint): number {
  const digits = units.toString().padStart(MONEY_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - MONEY_SCALE);
  const fraction = digits.slice(digits.length - MONEY_SCALE);
  return Number(`${whole}.${fraction}`);
}

function safeNumberOf(value: bigint): number | undefined {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function usageError(error: UsageQueryError): ToolOutcome {
  switch (error.kind) {
    case 'no_ingestion_run':
    case 'cost_incomplete':
    case 'malformed_row':
    case 'sqlite_error':
      return failure('data_unavailable');
  }
}

function snapshotOf(database: PersistenceDatabase): CapabilityStateSnapshot {
  const rows = listCapabilityState(database);
  return rows.ok ? { kind: 'available', entries: rows.value } : { kind: 'unavailable' };
}

function platformTotals(aggregate: PlatformUsageAggregate): JsonValue | undefined {
  const input = safeNumberOf(aggregate.inputTokens);
  const output = safeNumberOf(aggregate.outputTokens);
  const total = safeNumberOf(aggregate.inputTokens + aggregate.outputTokens);
  const requests = aggregate.requests === null ? null : safeNumberOf(aggregate.requests);
  if (
    input === undefined ||
    output === undefined ||
    total === undefined ||
    requests === undefined
  ) {
    return undefined;
  }
  return {
    platform: aggregate.platform,
    requests,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cost_usd: usdNumberOf(aggregate.costE8),
  };
}

export function createToolService(context: ToolServiceContext): ToolService {
  const { database, directory, environment } = context;

  function readableGroup(actor: TrustedActor, requestedGroup: unknown): GroupId | Denial {
    const decision = authorizeRead({
      environment,
      actor,
      requestedGroup,
      directory,
      capabilityState: snapshotOf(database),
    });
    return decision.kind === 'allow' ? decision.group : decision.denial;
  }

  function usagePeriod(rawPeriod: unknown): ResolvedPeriod | ToolOutcome {
    const period = resolvePeriod(rawPeriod);
    return period.ok ? period.value : failure('invalid_input');
  }

  /** Data checks run only after every argument has been validated. */
  function ingestionMissing(): ToolOutcome | undefined {
    const ingested = hasIngestionRun(database);
    if (!ingested.ok) {
      return usageError(ingested.error);
    }
    return ingested.value ? undefined : failure('data_unavailable');
  }

  function usageSummary(group: GroupId, rawPeriod: unknown): ToolOutcome {
    const period = usagePeriod(rawPeriod);
    if ('kind' in period) {
      return period;
    }
    const missing = ingestionMissing();
    if (missing !== undefined) {
      return missing;
    }
    const aggregates = aggregateGroupUsage(database, {
      groupId: group,
      startDay: period.start,
      endExclusiveDay: period.endExclusive,
    });
    if (!aggregates.ok) {
      return usageError(aggregates.error);
    }
    if (aggregates.value.length === 0) {
      return failure('no_data');
    }
    const platforms: JsonValue[] = [];
    let totalTokens = 0n;
    let totalCost = 0n;
    for (const aggregate of aggregates.value) {
      const row = platformTotals(aggregate);
      if (row === undefined) {
        return failure('data_unavailable');
      }
      platforms.push(row);
      totalTokens += aggregate.inputTokens + aggregate.outputTokens;
      totalCost += aggregate.costE8;
    }
    const tokens = safeNumberOf(totalTokens);
    if (tokens === undefined) {
      return failure('data_unavailable');
    }
    return {
      kind: 'ok',
      value: {
        group,
        period: { start: period.start, end_exclusive: period.endExclusive },
        platforms,
        totals: { total_tokens: tokens, cost_usd: usdNumberOf(totalCost) },
      },
    };
  }

  function topUsers(group: GroupId, args: Args): ToolOutcome {
    const period = usagePeriod(args['period']);
    if ('kind' in period) {
      return period;
    }
    const limit = parseLimit(args['limit']);
    if (limit === undefined) {
      return failure('invalid_input');
    }
    const missing = ingestionMissing();
    if (missing !== undefined) {
      return missing;
    }
    const ranked = rankGroupUsers(database, {
      groupId: group,
      startDay: period.start,
      endExclusiveDay: period.endExclusive,
    });
    if (!ranked.ok) {
      return usageError(ranked.error);
    }
    if (ranked.value.length === 0) {
      return failure('no_data');
    }
    const rows: JsonValue[] = [];
    for (const user of ranked.value.slice(0, limit)) {
      const tokens = safeNumberOf(user.totalTokens);
      if (tokens === undefined) {
        return failure('data_unavailable');
      }
      const email = [...directory.usersById.values()].find(
        (candidate) => candidate.userId === user.userId,
      )?.email;
      rows.push({
        user_id: user.userId,
        name: user.name,
        ...(email === undefined ? {} : { email }),
        group,
        total_tokens: tokens,
        cost_usd: usdNumberOf(user.costE8),
      });
    }
    return { kind: 'ok', value: rows };
  }

  function capabilityStatus(group: GroupId): ToolOutcome {
    const rows = listCapabilityState(database);
    if (!rows.ok) {
      return failure('data_unavailable');
    }
    const value: JsonValue[] = [];
    for (const capability of CAPABILITIES) {
      const matches = rows.value.filter(
        (row) => row.groupId === group && row.capability === capability,
      );
      const [row, ...extra] = matches;
      if (row === undefined || extra.length > 0) {
        return failure('data_unavailable');
      }
      value.push({
        group,
        capability,
        enabled: row.enabled,
        updated_at: row.updatedAt,
        updated_by: row.updatedBy,
      });
    }
    return { kind: 'ok', value };
  }

  function setCapability(actor: TrustedActor, group: GroupId, args: Args): ToolOutcome {
    const rawCapability = args['capability'];
    const capability =
      typeof rawCapability === 'string' ? parseCapability(rawCapability) : undefined;
    const enabled = args['enabled'];
    if (capability === undefined || !capability.ok || typeof enabled !== 'boolean') {
      return failure('invalid_input');
    }
    const result = setCapabilityState(database, {
      groupId: group,
      capability: capability.value,
      enabled,
      updatedAt: context.now().toISOString(),
      updatedBy: actor.userId,
    });
    if (!result.ok) {
      return failure('data_unavailable');
    }
    const { row } = result.value;
    return {
      kind: 'ok',
      value: {
        group: row.groupId,
        capability: row.capability,
        enabled: row.enabled,
        updated_at: row.updatedAt,
        updated_by: row.updatedBy,
      },
    };
  }

  return {
    invoke(trustedUserId, toolRaw, rawArgs) {
      const tool = parseToolName(toolRaw);
      if (tool === undefined) {
        return failure('unknown_tool');
      }
      const args = parseArguments(tool, rawArgs);
      if (args === undefined) {
        return failure('invalid_input');
      }
      const actor = resolveActor(directory, trustedUserId);
      if (!actor.ok) {
        return { kind: 'denied', denial: actor.error };
      }
      if (tool === 'set_capability') {
        const decision = authorizeCapabilityWrite({
          environment,
          actor: actor.value,
          requestedGroup: args['group'],
          directory,
        });
        return decision.kind === 'allow'
          ? setCapability(actor.value, decision.group, args)
          : { kind: 'denied', denial: decision.denial };
      }
      const group = readableGroup(actor.value, args['group']);
      if (typeof group !== 'string') {
        return { kind: 'denied', denial: group };
      }
      switch (tool) {
        case 'usage_summary':
          return usageSummary(group, args['period']);
        case 'top_users':
          return topUsers(group, args);
        case 'capability_status':
          return capabilityStatus(group);
      }
    },
  };
}
