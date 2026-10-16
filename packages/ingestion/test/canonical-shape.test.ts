import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChargeObservation, Directory, UsageObservation } from '@meridian/domain';
import { loadDirectory } from '../src/directory/adapter.js';
import { loadClaudeCost } from '../src/claude/cost.js';
import { loadClaudeUsage } from '../src/claude/usage.js';
import { loadGeminiBilling } from '../src/gemini/billing.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../starter-kit/data/${name}`, import.meta.url), 'utf8');

const loaded = loadDirectory(fixture('directory/users.json'), fixture('directory/groups.json'));
if (!loaded.ok) {
  throw new Error(`fixture directory failed to load: ${loaded.error}`);
}
const directory: Directory = loaded.value;

/** Vendor field names that must never appear in canonical observations. */
const RAW_KEYS = new Set([
  'actor',
  'labels',
  'project',
  'sku',
  'rbac_group_id',
  'server_tool_use',
  'cost_type',
  'list_amount',
  'credits',
  'adjustment_info',
  'effective_price',
  'usage_start_time',
  'usage_end_time',
  'starting_at',
  'ending_at',
  'cache_creation',
  'owner',
  'invoice',
  'export_time',
]);

const EXPECTED_KEYS: Record<string, readonly string[]> = {
  'claude:usage': [
    'platform',
    'kind',
    'userId',
    'groupId',
    'period',
    'model',
    'dimension',
    'uncachedInput',
    'cacheReadInput',
    'cacheCreation5mInput',
    'cacheCreation1hInput',
    'output',
    'inputTotal',
    'requests',
    'webSearchRequests',
  ],
  'claude:charge': [
    'platform',
    'kind',
    'userId',
    'groupId',
    'period',
    'model',
    'dimension',
    'chargeKind',
    'amount',
  ],
  'gemini:usage': [
    'platform',
    'kind',
    'userId',
    'groupId',
    'period',
    'model',
    'dimension',
    'direction',
    'tokens',
    'requests',
    'cache',
    'webSearch',
  ],
  'gemini:charge': [
    'platform',
    'kind',
    'userId',
    'groupId',
    'period',
    'model',
    'dimension',
    'direction',
    'amount',
  ],
};

/** Collects every key at any depth, so nested vendor objects cannot hide. */
const keysDeep = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
};

type Observation = UsageObservation | ChargeObservation;

const resolvedObservations = (): Observation[] => {
  const usage = loadClaudeUsage(fixture('claude/user_usage_report.json'), directory);
  const cost = loadClaudeCost(fixture('claude/user_cost_report.json'), directory);
  const gemini = loadGeminiBilling(
    fixture('gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl'),
    directory,
  );
  if (typeof usage === 'string' || typeof cost === 'string') {
    throw new Error('fixture failed to load');
  }
  const observations: Observation[] = [];
  for (const outcome of [...usage, ...cost]) {
    if (outcome.kind === 'resolved') {
      observations.push(outcome.value);
    }
  }
  for (const outcome of gemini) {
    if (outcome.kind === 'resolved') {
      observations.push(outcome.value.usage, outcome.value.charge);
    }
  }
  return observations;
};

describe('canonical observations expose no vendor-raw structures', () => {
  const observations = resolvedObservations();

  it('loads resolved observations from every Claude and Gemini fixture', () => {
    expect(observations.some((o) => o.platform === 'claude' && o.kind === 'usage')).toBe(true);
    expect(observations.some((o) => o.platform === 'claude' && o.kind === 'charge')).toBe(true);
    expect(observations.some((o) => o.platform === 'gemini' && o.kind === 'usage')).toBe(true);
    expect(observations.some((o) => o.platform === 'gemini' && o.kind === 'charge')).toBe(true);
  });

  it('uses only the fixed canonical key set for each platform and kind', () => {
    for (const observation of observations) {
      const expected = EXPECTED_KEYS[`${observation.platform}:${observation.kind}`];
      expect(expected).toBeDefined();
      expect(Object.keys(observation).sort()).toEqual([...(expected ?? [])].sort());
    }
  });

  it('contains no nested vendor-raw keys at any depth', () => {
    for (const observation of observations) {
      const leaked = keysDeep(observation).filter((key) => RAW_KEYS.has(key));
      expect(leaked).toEqual([]);
    }
  });
});
