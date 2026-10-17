import { CAPABILITIES, type Capability } from '../../../packages/domain/src/index.js';
import type { JsonValue, ToolOutcome, ToolService } from '../../api/src/index.js';

/** Data window of the supplied exports (starter-kit README). Display scope only, not policy. */
export const WEEKS = [
  '2026-W32',
  '2026-W33',
  '2026-W34',
  '2026-W35',
  '2026-W36',
  '2026-W37',
  '2026-W38',
  '2026-W39',
] as const;
export const DEFAULT_WEEK = '2026-W39';

export type Section<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: 'denied';
      readonly code: string;
      readonly reason: string;
      readonly requiredScope?: string;
    }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | { readonly kind: 'invalid' };

export interface PlatformRow {
  readonly platform: string;
  readonly requests: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface UsageSummary {
  readonly group: string;
  readonly platforms: readonly PlatformRow[];
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}

export interface TopUserRow {
  readonly userId: string;
  readonly name: string;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface CapabilityRow {
  readonly group: string;
  readonly capability: Capability;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface Dashboard {
  readonly caller: string;
  /** Empty string means "the caller's home group" (argument omitted). */
  readonly group: string;
  readonly week: string;
  readonly weeks: readonly { readonly week: string; readonly usage: Section<UsageSummary> }[];
  readonly topUsers: Section<readonly TopUserRow[]>;
  readonly capabilities: Section<readonly CapabilityRow[]>;
}

type Record_ = Readonly<Record<string, JsonValue>>;

const isRecord = (value: JsonValue | undefined): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

function str(record: Record_, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function nullableStr(record: Record_, key: string): string | null | undefined {
  const value = record[key];
  return typeof value === 'string' || value === null ? value : undefined;
}

function num(record: Record_, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function parsePlatform(value: JsonValue): PlatformRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const platform = str(value, 'platform');
  const requests = value['requests'];
  const inputTokens = num(value, 'input_tokens');
  const outputTokens = num(value, 'output_tokens');
  const totalTokens = num(value, 'total_tokens');
  const costUsd = num(value, 'cost_usd');
  if (
    platform === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined ||
    costUsd === undefined ||
    (requests !== null && typeof requests !== 'number')
  ) {
    return undefined;
  }
  return { platform, requests: requests ?? null, inputTokens, outputTokens, totalTokens, costUsd };
}

function parseUsage(value: JsonValue): UsageSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const group = str(value, 'group');
  const rows = value['platforms'];
  const totals = value['totals'];
  if (group === undefined || !isArray(rows) || !isRecord(totals)) {
    return undefined;
  }
  const platforms = rows.map(parsePlatform);
  const totalTokens = num(totals, 'total_tokens');
  const totalCostUsd = num(totals, 'cost_usd');
  const valid = platforms.flatMap((row) => (row === undefined ? [] : [row]));
  if (
    valid.length !== platforms.length ||
    totalTokens === undefined ||
    totalCostUsd === undefined
  ) {
    return undefined;
  }
  return { group, platforms: valid, totalTokens, totalCostUsd };
}

function parseTopUsers(value: JsonValue): readonly TopUserRow[] | undefined {
  if (!isArray(value)) {
    return undefined;
  }
  const rows: TopUserRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    const userId = str(item, 'user_id');
    const name = str(item, 'name');
    const totalTokens = num(item, 'total_tokens');
    const costUsd = num(item, 'cost_usd');
    if (
      userId === undefined ||
      name === undefined ||
      totalTokens === undefined ||
      costUsd === undefined
    ) {
      return undefined;
    }
    rows.push({ userId, name, totalTokens, costUsd });
  }
  return rows;
}

function parseCapabilityRow(item: JsonValue): CapabilityRow | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const group = str(item, 'group');
  const capability = CAPABILITIES.find((candidate) => candidate === item['capability']);
  const enabled = item['enabled'];
  const updatedAt = nullableStr(item, 'updated_at');
  const updatedBy = nullableStr(item, 'updated_by');
  if (
    group === undefined ||
    capability === undefined ||
    typeof enabled !== 'boolean' ||
    updatedAt === undefined ||
    updatedBy === undefined
  ) {
    return undefined;
  }
  return { group, capability, enabled, updatedAt, updatedBy };
}

function parseCapabilities(value: JsonValue): readonly CapabilityRow[] | undefined {
  if (!isArray(value)) {
    return undefined;
  }
  const rows = value.map(parseCapabilityRow);
  const valid = rows.flatMap((row) => (row === undefined ? [] : [row]));
  return valid.length === rows.length ? valid : undefined;
}

/** Maps a service outcome to a section without interpreting why access was refused. */
function sectionOf<T>(
  outcome: ToolOutcome,
  parse: (value: JsonValue) => T | undefined,
): Section<T> {
  switch (outcome.kind) {
    case 'ok': {
      const value = parse(outcome.value);
      return value === undefined ? { kind: 'invalid' } : { kind: 'ok', value };
    }
    case 'denied': {
      const { code, reason, required_scope: requiredScope } = outcome.denial;
      return requiredScope === undefined
        ? { kind: 'denied', code, reason }
        : { kind: 'denied', code, reason, requiredScope };
    }
    case 'error':
      return { kind: 'error', code: outcome.error.error, message: outcome.error.message };
  }
}

const groupArgs = (group: string): { readonly group?: string } => (group === '' ? {} : { group });

export function loadDashboard(
  service: ToolService,
  query: { readonly caller: string; readonly group: string; readonly week: string },
): Dashboard {
  const { caller, group, week } = query;
  return {
    caller,
    group,
    week,
    weeks: WEEKS.map((candidate) => ({
      week: candidate,
      usage: sectionOf(
        service.invoke(caller, 'usage_summary', { ...groupArgs(group), period: candidate }),
        parseUsage,
      ),
    })),
    topUsers: sectionOf(
      service.invoke(caller, 'top_users', { ...groupArgs(group), period: week }),
      parseTopUsers,
    ),
    capabilities: sectionOf(
      service.invoke(caller, 'capability_status', groupArgs(group)),
      parseCapabilities,
    ),
  };
}

export type ChangeResult =
  | { readonly kind: 'updated'; readonly row: CapabilityRow }
  | Exclude<Section<never>, { readonly kind: 'ok' }>;

export function changeCapability(
  service: ToolService,
  input: {
    readonly caller: string;
    readonly group: string;
    readonly capability: string;
    readonly enabled: boolean;
  },
): ChangeResult {
  const section = sectionOf(
    service.invoke(input.caller, 'set_capability', {
      group: input.group,
      capability: input.capability,
      enabled: input.enabled,
    }),
    parseCapabilityRow,
  );
  return section.kind === 'ok' ? { kind: 'updated', row: section.value } : section;
}
