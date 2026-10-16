import type { Measure, RawRow } from '../raw/measures.js';
import { compareStrings } from '../ingest/identity.js';

/** A comparable per-row bundle of measures; raw rows and canonical observations both map to it. */
export type Fact = RawRow;

export interface Cell {
  readonly sum: bigint;
  readonly unmeasurable: boolean;
}

export interface Bucket {
  readonly facts: number;
  readonly cells: ReadonlyMap<string, Cell>;
}

export type Rollup = ReadonlyMap<string, Bucket>;

export type SelectorName = 'platform' | 'model' | 'week' | 'group' | 'groupWeek';

export const SELECTOR_NAMES: readonly SelectorName[] = [
  'platform',
  'model',
  'week',
  'group',
  'groupWeek',
];

type Selector = (fact: Fact) => string;

/** One grouping mechanism; every rollup only differs by key selector. */
export const SELECTORS: Readonly<Record<SelectorName, Selector>> = {
  platform: (fact) => fact.platform,
  model: (fact) => fact.model,
  week: (fact) => fact.week,
  group: (fact) => fact.group,
  groupWeek: (fact) => JSON.stringify([fact.group, fact.week]),
};

export function groupFacts(facts: readonly Fact[], selector: Selector): Rollup {
  const buckets = new Map<string, { facts: number; cells: Map<string, Cell> }>();
  for (const fact of facts) {
    const key = selector(fact);
    const bucket = buckets.get(key) ?? { facts: 0, cells: new Map<string, Cell>() };
    bucket.facts += 1;
    for (const [name, measure] of fact.measures) {
      const cell = bucket.cells.get(name) ?? { sum: 0n, unmeasurable: false };
      bucket.cells.set(name, addMeasure(cell, measure));
    }
    buckets.set(key, bucket);
  }
  return new Map([...buckets.entries()].sort(([a], [b]) => compareStrings(a, b)));
}

function addMeasure(cell: Cell, measure: Measure): Cell {
  return measure.kind === 'measured'
    ? { sum: cell.sum + measure.value, unmeasurable: cell.unmeasurable }
    : { sum: cell.sum, unmeasurable: true };
}

export type RollupSet = Readonly<Record<SelectorName, Rollup>>;

export function buildRollupSet(facts: readonly Fact[]): RollupSet {
  return {
    platform: groupFacts(facts, SELECTORS.platform),
    model: groupFacts(facts, SELECTORS.model),
    week: groupFacts(facts, SELECTORS.week),
    group: groupFacts(facts, SELECTORS.group),
    groupWeek: groupFacts(facts, SELECTORS.groupWeek),
  };
}

const ZERO: Cell = { sum: 0n, unmeasurable: false };

/**
 * Internal consistency of one rollup set: every partition of a platform must sum back to the
 * platform total, for fact counts and every measure.
 */
export function rollupSumIssues(
  set: RollupSet,
  label: string,
  includeMeasure: (name: string) => boolean,
): { code: string; subject: string }[] {
  const issues: { code: string; subject: string }[] = [];
  const total = set.platform.get([...set.platform.keys()][0] ?? '');
  if (total === undefined) {
    return issues;
  }
  const measures = [...total.cells.keys()].filter(includeMeasure).sort(compareStrings);

  const sumBuckets = (rollup: Rollup, accept: (key: string) => boolean, measure: string): Cell => {
    let sum = 0n;
    let unmeasurable = false;
    for (const [key, bucket] of rollup) {
      if (accept(key)) {
        const cell = bucket.cells.get(measure) ?? ZERO;
        sum += cell.sum;
        unmeasurable ||= cell.unmeasurable;
      }
    }
    return { sum, unmeasurable };
  };
  const countFacts = (rollup: Rollup, accept: (key: string) => boolean): number => {
    let n = 0;
    for (const [key, bucket] of rollup) {
      if (accept(key)) {
        n += bucket.facts;
      }
    }
    return n;
  };
  const any = (): boolean => true;

  for (const name of ['week', 'group', 'groupWeek'] as const) {
    if (countFacts(set[name], any) !== total.facts) {
      issues.push({ code: 'rollup_fact_count_mismatch', subject: `${label}/${name}` });
    }
    for (const measure of measures) {
      const totalCell = total.cells.get(measure) ?? ZERO;
      const cell = sumBuckets(set[name], any, measure);
      if (!totalCell.unmeasurable && !cell.unmeasurable && cell.sum !== totalCell.sum) {
        issues.push({ code: 'rollup_sum_mismatch', subject: `${label}/${name}/${measure}` });
      }
    }
  }

  const pairOf = (key: string): [string, string] => {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      ? [parsed[0], parsed[1]]
      : ['', ''];
  };
  for (const [name, index] of [
    ['group', 0],
    ['week', 1],
  ] as const) {
    for (const [key, bucket] of set[name]) {
      const matches = (cellKey: string): boolean => pairOf(cellKey)[index] === key;
      if (countFacts(set.groupWeek, matches) !== bucket.facts) {
        issues.push({ code: 'rollup_fact_count_mismatch', subject: `${label}/${name}/${key}` });
      }
      for (const measure of measures) {
        const expected = bucket.cells.get(measure) ?? ZERO;
        const actual = sumBuckets(set.groupWeek, matches, measure);
        if (!expected.unmeasurable && !actual.unmeasurable && actual.sum !== expected.sum) {
          issues.push({
            code: 'rollup_sum_mismatch',
            subject: `${label}/${name}/${key}/${measure}`,
          });
        }
      }
    }
  }
  return issues;
}
