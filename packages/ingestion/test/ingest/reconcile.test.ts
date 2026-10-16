import { describe, expect, it } from 'vitest';
import { finalizeRun, processArtifacts } from '../../src/ingest/ingest.js';
import type { Observation } from '../../src/ingest/types.js';
import { detectGaps } from '../../src/reconcile/gaps.js';
import { measureClass } from '../../src/raw/measures.js';
import { canonicalFacts } from '../../src/reconcile/reconcile.js';
import {
  buildRollupSet,
  rollupSumIssues,
  type Bucket,
  type Rollup,
  type RollupSet,
} from '../../src/reconcile/rollup.js';
import { fixtureArtifacts } from './fixture-helpers.js';

const DATA = processArtifacts(fixtureArtifacts());
const WINDOW = { start: '2026-08-03', end: '2026-09-27' };
const BASE = finalizeRun(DATA, { expectedWindows: { claude: WINDOW, gemini: WINDOW } });
const checkOf = (result: ReturnType<typeof finalizeRun>, id: string) =>
  result.report.reconciliation.checks.find((c) => c.id === id);

function tamperAt(
  observations: readonly Observation[],
  predicate: (o: Observation) => boolean,
  change: (o: Observation) => Observation,
): Observation[] {
  const index = observations.findIndex(predicate);
  if (index < 0) {
    throw new Error('no observation to tamper with');
  }
  return observations.map((o, i) => (i === index ? change(o) : o));
}

describe('tamper detection', () => {
  it('X7: a one-unit money change fails reconciliation and the run', () => {
    for (const platform of ['claude', 'gemini'] as const) {
      const tampered = tamperAt(
        DATA.canonical,
        (o) => o.platform === platform && o.kind === 'charge',
        (o) => (o.kind === 'charge' ? { ...o, amount: o.amount + 1n } : o),
      );
      const result = finalizeRun(DATA, {}, tampered);
      expect(checkOf(result, `${platform}.platform.money`)?.status).toBe('fail');
      expect(checkOf(result, `${platform}.platform.money`)?.deltas[0]?.unexplained).toBe(-1n);
      expect(result.report.status).toBe('failed');
    }
  });

  it('X8: a one-token change fails reconciliation and the run', () => {
    const claude = tamperAt(
      DATA.canonical,
      (o) => o.platform === 'claude' && o.kind === 'usage',
      (o) => (o.platform === 'claude' && o.kind === 'usage' ? { ...o, output: o.output + 1 } : o),
    );
    const r1 = finalizeRun(DATA, {}, claude);
    expect(checkOf(r1, 'claude.platform.tokens')?.status).toBe('fail');
    expect(r1.report.status).toBe('failed');

    const gemini = tamperAt(
      DATA.canonical,
      (o) => o.platform === 'gemini' && o.kind === 'usage',
      (o) =>
        o.platform === 'gemini' && o.kind === 'usage' && o.tokens.kind === 'known'
          ? { ...o, tokens: { kind: 'known', value: o.tokens.value + 1 } }
          : o,
    );
    const r2 = finalizeRun(DATA, {}, gemini);
    expect(checkOf(r2, 'gemini.model.tokens')?.status).toBe('fail');
    expect(r2.report.status).toBe('failed');
  });

  it('fails when an accepted observation is dropped or invented', () => {
    const dropped = DATA.canonical.slice(1);
    expect(finalizeRun(DATA, {}, dropped).report.status).toBe('failed');
  });

  it('fails when a canonical group assignment disagrees with the raw directory', () => {
    const regrouped = tamperAt(
      DATA.canonical,
      (o) => o.platform === 'claude' && o.kind === 'charge',
      (o) => {
        const other = DATA.canonical.find((c) => c.groupId !== o.groupId)?.groupId;
        return other === undefined ? o : { ...o, groupId: other };
      },
    );
    const result = finalizeRun(DATA, {}, regrouped);
    expect(checkOf(result, 'claude.group.money')?.status).toBe('fail');
    expect(checkOf(result, 'claude.platform.money')?.status).toBe('pass');
    expect(result.report.status).toBe('failed');
  });
});

describe('rollups', () => {
  const facts = canonicalFacts(DATA.canonical);
  const sets = (['claude', 'gemini'] as const).map((platform) =>
    buildRollupSet(facts.filter((f) => f.platform === platform)),
  );

  it('P1-P3: every rollup partitions the platform total', () => {
    for (const set of sets) {
      expect(rollupSumIssues(set, 'canonical', () => true)).toEqual([]);
      const total = [...set.platform.values()][0]?.facts ?? 0;
      for (const name of ['week', 'group', 'groupWeek'] as const) {
        const cells = [...set[name].values()].reduce((n, b) => n + b.facts, 0);
        expect(cells).toBe(total);
      }
    }
    expect(sets[0] === undefined || sets[0].week.size > 1).toBe(true);
    for (const check of BASE.report.reconciliation.checks) {
      expect(check.status).toBe('pass');
    }
  });

  it('P3: every observation sits in exactly one group x week cell', () => {
    const [claude] = sets;
    const cellFacts = [...(claude?.groupWeek.values() ?? [])].reduce((n, b) => n + b.facts, 0);
    expect(cellFacts).toBe(DATA.canonical.filter((o) => o.platform === 'claude').length);
  });

  it('P4: a one-unit rollup corruption is detected', () => {
    const [claude] = sets;
    if (claude === undefined) {
      throw new Error('missing rollup');
    }
    const week: Rollup = claude.week;
    const [key, bucket] = [...week.entries()][0] ?? ['', undefined];
    if (bucket === undefined) {
      throw new Error('missing bucket');
    }
    const cells = new Map(bucket.cells);
    const cell = cells.get('output');
    if (cell === undefined) {
      throw new Error('missing cell');
    }
    cells.set('output', { ...cell, sum: cell.sum + 1n });
    const corrupted: Bucket = { facts: bucket.facts, cells };
    const set: RollupSet = { ...claude, week: new Map([...week.entries()]).set(key, corrupted) };
    const issues = rollupSumIssues(set, 'canonical', (name) => measureClass(name) === 'tokens');
    expect(issues.map((i) => i.code)).toContain('rollup_sum_mismatch');
  });
});

describe('gap detection', () => {
  it('G1: reports no gap, one gap and multiple gaps', () => {
    expect(detectGaps('p', ['2026-08-01', '2026-08-02', '2026-08-03']).missingDays).toEqual([]);
    expect(detectGaps('p', ['2026-08-03', '2026-08-01']).missingDays).toEqual(['2026-08-02']);
    expect(
      detectGaps('p', ['2026-08-01', '2026-08-04', '2026-08-04', '2026-08-07']).missingDays,
    ).toEqual(['2026-08-02', '2026-08-03', '2026-08-05', '2026-08-06']);
    expect(detectGaps('p', []).sourceDays).toBe(0);
  });

  it('G1: honours an explicit expected window', () => {
    const report = detectGaps('p', ['2026-08-02'], { start: '2026-08-01', end: '2026-08-03' });
    expect(report.missingDays).toEqual(['2026-08-01', '2026-08-03']);
  });

  it('G2: fixture coverage is a warning, not a zero observation', () => {
    const [claude, gemini] = BASE.report.reconciliation.gaps;
    expect(claude).toEqual({
      platform: 'claude',
      status: 'evaluated',
      sourceDays: 56,
      missingDays: [],
    });
    expect(gemini).toEqual({
      platform: 'gemini',
      status: 'evaluated',
      sourceDays: 55,
      missingDays: ['2026-08-23'],
    });
    expect(BASE.report.status).toBe('complete');
    expect(DATA.canonical.some((o) => o.platform === 'gemini' && o.period === '2026-08-23')).toBe(
      false,
    );
  });
});
