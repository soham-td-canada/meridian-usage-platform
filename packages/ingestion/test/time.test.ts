import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Directory, Outcome, UsageObservation } from '@meridian/domain';
import { loadDirectory } from '../src/directory/adapter.js';
import { parseClaudeUsageRow } from '../src/claude/usage.js';
import { parseGeminiRow, type GeminiRowResult } from '../src/gemini/billing.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../starter-kit/data/${name}`, import.meta.url), 'utf8');

const loaded = loadDirectory(fixture('directory/users.json'), fixture('directory/groups.json'));
if (!loaded.ok) {
  throw new Error(`fixture directory failed to load: ${loaded.error}`);
}
const directory: Directory = loaded.value;

type Row = Record<string, unknown>;

const usageRow = (): Row =>
  JSON.parse(
    JSON.stringify(
      (JSON.parse(fixture('claude/user_usage_report.json')) as { data: unknown[] }).data[0],
    ),
  ) as Row;

const claudeWith = (
  field: 'starting_at' | 'ending_at',
  value: string,
): Outcome<UsageObservation> => {
  const row = usageRow();
  row[field] = value;
  return parseClaudeUsageRow(row, 0, directory);
};

const geminiLines = fixture('gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl')
  .split('\n')
  .filter((line) => line.length > 0);

const geminiWith = (
  field: 'usage_start_time' | 'usage_end_time',
  value: string,
): Outcome<GeminiRowResult> => {
  const row = JSON.parse(geminiLines[0] ?? '') as Row;
  row[field] = value;
  return parseGeminiRow(JSON.stringify(row), 0, directory);
};

describe('Claude timestamps reject values Date.parse would normalize', () => {
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-08-00T00:00:00Z',
    '2026-08-03T24:00:00Z',
    '2026-08-03T23:60:00Z',
    '2026-08-03T23:59:60Z',
    '2026-08-03T00:00:00+00:00',
  ])('rejects starting_at %s', (value) => {
    expect(claudeWith('starting_at', value).kind).toBe('rejected');
  });

  it('rejects an impossible ending_at even when the start is valid', () => {
    expect(claudeWith('ending_at', '2026-08-04T24:00:00Z').kind).toBe('rejected');
  });

  it('accepts a leap day in a leap year', () => {
    const row = usageRow();
    row['starting_at'] = '2024-02-29T00:00:00Z';
    row['ending_at'] = '2024-03-01T00:00:00Z';
    expect(parseClaudeUsageRow(row, 0, directory).kind).toBe('resolved');
  });
});

describe('Gemini timestamps reject values Date.parse would normalize', () => {
  it.each([
    '2026-02-30 00:00:00 UTC',
    '2026-02-29 00:00:00 UTC',
    '2026-08-05 24:00:00 UTC',
    '2026-08-05 23:59:60 UTC',
    '2026-08-05 12:60:00 UTC',
  ])('rejects usage_start_time %s', (value) => {
    expect(geminiWith('usage_start_time', value).kind).toBe('rejected');
  });

  it('rejects an impossible usage_end_time', () => {
    expect(geminiWith('usage_end_time', '2026-08-06 24:00:00 UTC').kind).toBe('rejected');
  });
});
