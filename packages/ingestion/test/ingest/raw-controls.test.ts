import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isoWeekOf, type UtcDay } from '@meridian/domain';
import { ingest } from '../../src/ingest/ingest.js';
import { rawIsoWeek, dateRange } from '../../src/raw/calendar.js';
import { decimalToUnits, integerFromLexeme } from '../../src/raw/decimal.js';
import { canonicalJson, parseLexicalJson } from '../../src/raw/lexical-json.js';
import {
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  withFields,
} from './fixture-helpers.js';

const BASELINE = ingest(fixtureArtifacts());
const deltas = (result: ReturnType<typeof ingest>, id: string) =>
  result.report.reconciliation.checks.find((c) => c.id === id)?.deltas ?? [];

describe('X10: raw-control independence', () => {
  const dir = new URL('../../src/raw/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));

  it('only imports sibling raw modules', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[a-z-]+\.js$/);
      }
    }
  });
});

describe('exact raw arithmetic', () => {
  it('converts decimals exactly and refuses inexact values', () => {
    expect(decimalToUnits('88.900050', 6)).toBe(88900050n);
    expect(decimalToUnits('0.107564', 8)).toBe(10756400n);
    expect(decimalToUnits('3e-07', 8)).toBe(30n);
    expect(decimalToUnits('0.0000000001', 8)).toBeUndefined();
    expect(decimalToUnits('-1.5', 2)).toBe(-150n);
    expect(decimalToUnits('abc', 2)).toBeUndefined();
    expect(integerFromLexeme('358546.0')).toBe(358546n);
    expect(integerFromLexeme('1.5')).toBeUndefined();
  });

  it('parses lexemes strictly and canonicalizes deterministically', () => {
    expect(() => parseLexicalJson('{"a":1,}')).toThrow();
    expect(() => parseLexicalJson('{"a":1')).toThrow();
    expect(canonicalJson(parseLexicalJson('{ "b": 1.50, "a": [true, null] }'))).toBe(
      '{"a":[true,null],"b":1.50}',
    );
  });

  it('derives ISO weeks independently but identically to the domain', () => {
    for (const day of dateRange('2024-12-20', '2027-01-10')) {
      expect(rawIsoWeek(day)).toBe(isoWeekOf(day as UtcDay));
    }
  });
});

describe('Claude and Gemini controls', () => {
  it('X1: Claude money equals 283028776008n with zero delta', () => {
    const [line] = deltas(BASELINE, 'claude.platform.money');
    expect(line?.raw).toBe(283028776008n);
    expect(line?.canonical).toBe(283028776008n);
    expect(line?.unexplained).toBe(0n);
  });

  it('X2: Claude tokens reconcile per field and in total', () => {
    const lines = deltas(BASELINE, 'claude.platform.tokens');
    expect(lines.map((l) => l.measure)).toEqual([
      'cacheCreation1hInput',
      'cacheCreation5mInput',
      'cacheReadInput',
      'inputTotal',
      'output',
      'totalTokens',
      'uncachedInput',
    ]);
    for (const line of lines) {
      expect(line.unexplained).toBe(0n);
      expect(line.raw).toBe(line.canonical);
    }
    const by = (name: string) => lines.find((l) => l.measure === name)?.raw ?? -1n;
    expect(by('totalTokens')).toBe(by('inputTotal') + by('output'));
    expect(by('inputTotal')).toBe(
      by('uncachedInput') +
        by('cacheReadInput') +
        by('cacheCreation5mInput') +
        by('cacheCreation1hInput'),
    );
  });

  it('keeps Claude requests usage-only', () => {
    const lines = deltas(BASELINE, 'claude.platform.counts');
    expect(lines.map((l) => l.measure)).toEqual(['requests', 'webSearchRequests']);
    expect(lines.every((l) => l.unexplained === 0n)).toBe(true);
  });

  it('X3: Gemini money reconciles exactly', () => {
    const [line] = deltas(BASELINE, 'gemini.platform.money');
    expect(line?.raw).toBe(28783943300n);
    expect(line?.canonical).toBe(line?.raw);
  });

  it('X4: Gemini tokens reconcile by direction and model, with requests unavailable', () => {
    const lines = deltas(BASELINE, 'gemini.model.tokens');
    expect(lines.map((l) => `${l.bucket}/${l.measure}`)).toEqual([
      'gemini-2.5-flash/tokens.input',
      'gemini-2.5-flash/tokens.output',
      'gemini-2.5-pro/tokens.input',
      'gemini-2.5-pro/tokens.output',
    ]);
    for (const line of lines) {
      expect(line.unexplained).toBe(0n);
      expect(line.raw).toBeGreaterThan(0n);
    }
    expect(
      BASELINE.report.reconciliation.checks.some((c) => c.id === 'gemini.platform.counts'),
    ).toBe(false);
  });
});

describe('explained exclusions', () => {
  const costs = claudeRows(FIXTURE.claudeCost);

  it('X6: an unresolved but measurable row is explained', () => {
    const target = first(costs);
    const unresolved = withFields(target, { rbac_group_id: 'rbac_group_UNKNOWN' });
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes([unresolved, ...costs.slice(1)]) }),
    );
    expect(result.report.counts.quarantined).toBe(1);
    const [line] = deltas(result, 'claude.platform.money');
    expect(line?.excluded).toBe(88900050n);
    expect(line?.unexplained).toBe(0n);
    expect(line?.raw).toBe(line === undefined ? 0n : line.canonical + line.excluded);
    expect(result.report.status).toBe('complete_with_exclusions');
  });

  it('X9: an unmeasurable excluded value fails reconciliation', () => {
    const broken = withFields(first(costs), { amount: 'not-a-number' });
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes([broken, ...costs.slice(1)]) }),
    );
    const check = result.report.reconciliation.checks.find((c) => c.id === 'claude.platform.money');
    expect(check?.status).toBe('fail');
    expect(check?.deltas.some((d) => d.unmeasurable)).toBe(true);
    expect(result.report.status).toBe('failed');
  });
});
