import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isoWeekOf,
  type ChargeObservation,
  type Directory,
  type Outcome,
  type UsageObservation,
  type UtcDay,
} from '@meridian/domain';
import { loadDirectory } from '../src/directory/adapter.js';
import { loadClaudeCost } from '../src/claude/cost.js';
import { loadClaudeUsage } from '../src/claude/usage.js';
import { loadGeminiBilling, type GeminiRowResult } from '../src/gemini/billing.js';

const STARTER_KIT = new URL('../../../starter-kit/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, STARTER_KIT), 'utf8');

const directoryResult = loadDirectory(
  read('data/directory/users.json'),
  read('data/directory/groups.json'),
);
if (!directoryResult.ok) {
  throw new Error(`fixture directory failed to load: ${directoryResult.error}`);
}
const directory: Directory = directoryResult.value;

const claudeUsageText = read('data/claude/user_usage_report.json');
const claudeCostText = read('data/claude/user_cost_report.json');
const geminiText = read('data/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl');

const usageOutcomes = loadClaudeUsage(claudeUsageText, directory);
const costOutcomes = loadClaudeCost(claudeCostText, directory);
const geminiOutcomes: Outcome<GeminiRowResult>[] = loadGeminiBilling(geminiText, directory);

const resolvedValues = <T>(outcomes: readonly Outcome<T>[] | string): T[] => {
  if (typeof outcomes === 'string') {
    throw new Error(outcomes);
  }
  return outcomes.map((outcome) => {
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
    return outcome.value;
  });
};

const usage = resolvedValues<UsageObservation>(usageOutcomes);
const charges = resolvedValues<ChargeObservation>(costOutcomes);
const gemini = resolvedValues<GeminiRowResult>(geminiOutcomes);

const pairKey = (obs: UsageObservation | ChargeObservation): string =>
  [obs.userId, obs.period, obs.dimension.name, obs.model].join('|');

describe('F1: Claude usage and cost pairing', () => {
  it('validates all 1,346 usage rows', () => {
    expect(usage).toHaveLength(1346);
  });

  it('resolves 1,346 token charges and 492 web_search charges', () => {
    expect(
      charges.filter((c) => c.platform === 'claude' && c.chargeKind === 'tokens'),
    ).toHaveLength(1346);
    expect(
      charges.filter((c) => c.platform === 'claude' && c.chargeKind === 'web_search'),
    ).toHaveLength(492);
  });

  it('pairs every charge to exactly one usage row with no orphans', () => {
    const usageKeys = new Map<string, number>();
    for (const obs of usage) {
      usageKeys.set(pairKey(obs), (usageKeys.get(pairKey(obs)) ?? 0) + 1);
    }
    expect([...usageKeys.values()].every((count) => count === 1)).toBe(true);

    const tokenCharges = new Map<string, number>();
    for (const charge of charges) {
      const key = pairKey(charge);
      expect(usageKeys.has(key)).toBe(true);
      if (charge.platform === 'claude' && charge.chargeKind === 'tokens') {
        tokenCharges.set(key, (tokenCharges.get(key) ?? 0) + 1);
      }
    }
    expect([...tokenCharges.values()].every((count) => count === 1)).toBe(true);
    expect(tokenCharges.size).toBe(usageKeys.size);
  });
});

describe('F2: Gemini rows and usage days', () => {
  it('validates and resolves all 990 Gemini rows', () => {
    expect(gemini).toHaveLength(990);
  });

  it('covers 55 distinct usage days with 2026-08-23 recorded as a gap', () => {
    const days = new Set<string>(gemini.map((row) => row.usage.period));
    expect(days.size).toBe(55);
    expect(days.has('2026-08-23')).toBe(false);
    const first = Date.parse(`${[...days].sort()[0] ?? ''}T00:00:00Z`);
    const last = Date.parse(`${[...days].sort().at(-1) ?? ''}T00:00:00Z`);
    expect((last - first) / 86_400_000 + 1).toBe(56);
  });
});

describe('F3: canonical cost sums equal independent decimal sums', () => {
  it('sums Claude cents exactly', () => {
    const rawCents = [...claudeCostText.matchAll(/"amount": "([0-9.]+)"/g)].map((m) => m[1] ?? '');
    expect(rawCents).toHaveLength(1838);
    const expected = rawCents.reduce((total, text) => {
      const [whole = '0', fraction = ''] = text.split('.');
      return total + BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    }, 0n);
    const actual = charges.reduce((total, c) => total + c.amount, 0n);
    expect(actual).toBe(expected);
  });

  it('sums Gemini USD exactly from raw cost lexemes', () => {
    const rawCosts = [...geminiText.matchAll(/"cost": ([0-9.]+),/g)].map((m) => m[1] ?? '');
    expect(rawCosts).toHaveLength(990);
    const expected = rawCosts.reduce((total, text) => {
      const [whole = '0', fraction = ''] = text.split('.');
      return total + BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
    }, 0n);
    const actual = gemini.reduce((total, row) => total + row.charge.amount, 0n);
    expect(actual).toBe(expected);
  });
});

describe('F4: Gemini price diagnostic', () => {
  it('reports no difference above 1e-6 USD and a max delta of at most 5e-7 USD', () => {
    const checked = gemini.map((row) => row.priceDiagnostic);
    expect(checked.every((d) => d.kind === 'checked')).toBe(true);
    const deltas = checked.flatMap((d) => (d.kind === 'checked' ? [d.deltaUnits] : []));
    expect(deltas.some((delta) => delta > 10n ** 24n)).toBe(false);
    const maxDelta = deltas.reduce((max, delta) => (delta > max ? delta : max), 0n);
    // Units are 1e-30 USD; 5e-7 USD is 5 * 10^23 units.
    expect(maxDelta <= 5n * 10n ** 23n).toBe(true);
  });
});

describe('F5: every observation is within ISO weeks W32 to W39', () => {
  it('assigns each fixture observation to one of W32..W39', () => {
    const allowed = new Set(Array.from({ length: 8 }, (_, index) => `2026-W${String(32 + index)}`));
    const periods: UtcDay[] = [
      ...usage.map((obs) => obs.period),
      ...charges.map((obs) => obs.period),
      ...gemini.map((row) => row.usage.period),
    ];
    for (const period of periods) {
      expect(allowed.has(isoWeekOf(period))).toBe(true);
    }
  });
});

describe('F6: starter-kit files are unchanged', () => {
  const expected: Record<string, string> = {
    'README.md': '011fc9fe3078dceb9fbe0305ef1e9e7a78a437567d1c901512859e86dc61de63',
    'data/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl':
      '2c284d888c9376e7fe5a656732887b861aeb6f494197c7d72fe9c560e248b990',
    'environments/staging.yaml': '3a3bb97f0f08306cf9acdbf826eb4f7d0f40637f20f47fdb768d3be2168bf537',
    'environments/prod.yaml': '5823f93c42f7637f47c7b158829cd69d7b03a5d1f125b9c54a349b6db7132d5e',
    'environments/dev.yaml': '5b9ef75341a9e831f6b845a53d4760c343ee2d37a1d9c93e8c8f8d78b77604ef',
    'data/directory/groups.json':
      '68ed0a2f7bb3fcb3d9ed634a652bec5af02408ac1ba882920c852149faf3770c',
    'contracts/tools.schema.json':
      '8df8cba38cb26337e54769bd7eb767019588f317a204eef5c81e2cae09482d0a',
    'data/claude/user_usage_report.json':
      'b044abf0a40618a339074262c87ed78e3d917b9bf5f96993a446b45d9dacf9da',
    'data/claude/user_cost_report.json':
      'b2dd2bd63bbcf750cd37a24a283a888cf036a223bf69da71be6a07eb7efb3a0d',
    'data/directory/users.json': 'fb8f24b8a4aec51a64474f092c3ffed4590592d48ff5209f61654a82568251ce',
  };

  it.each(Object.entries(expected))('%s matches its recorded SHA-256', (path, digest) => {
    const actual = createHash('sha256')
      .update(readFileSync(new URL(path, STARTER_KIT)))
      .digest('hex');
    expect(actual).toBe(digest);
  });
});
