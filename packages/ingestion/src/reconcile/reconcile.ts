import { isoWeekOf } from '@meridian/domain';
import { compareStrings, sha256Hex, type RowSourceKind } from '../ingest/identity.js';
import type { DisposedRow, Observation } from '../ingest/types.js';
import {
  measureClass,
  measured,
  type Measure,
  type MeasureClass,
  type Platform,
} from '../raw/measures.js';
import { compareRollups, lineFails } from './compare.js';
import { detectGaps, type DateWindow } from './gaps.js';
import { pairingIssues, type PairingRow } from './pairing.js';
import {
  buildRollupSet,
  rollupSumIssues,
  SELECTOR_NAMES,
  type Fact,
  type RollupSet,
} from './rollup.js';
import type { CheckResult, DeltaLine, GapReport, Issue } from './types.js';

export interface ReconcileInput {
  /** Every row of the run with its disposition. */
  readonly rows: readonly DisposedRow[];
  /** Canonical observations contributed by accepted rows. */
  readonly canonical: readonly Observation[];
  /** Sources that failed at file level or were not supplied. */
  readonly failedSources: ReadonlySet<RowSourceKind>;
  readonly expectedWindows?: Readonly<Partial<Record<Platform, DateWindow>>>;
}

export interface ReconciliationReport {
  readonly checks: readonly CheckResult[];
  readonly gaps: readonly GapReport[];
}

const PLATFORMS: readonly Platform[] = ['claude', 'gemini'];

const CLASSES: Readonly<Record<Platform, readonly MeasureClass[]>> = {
  claude: ['tokens', 'counts', 'money'],
  gemini: ['tokens', 'money'],
};

function requiredSources(platform: Platform, cls: MeasureClass): readonly RowSourceKind[] {
  if (platform === 'gemini') {
    return ['gemini_billing'];
  }
  return cls === 'money' ? ['claude_cost'] : ['claude_usage'];
}

const known = (value: number | bigint): Measure => measured(BigInt(value));

/** Path B: canonical observations expressed as comparable facts. */
export function canonicalFacts(observations: readonly Observation[]): Fact[] {
  return observations.map((obs): Fact => {
    const measures = new Map<string, Measure>();
    if (obs.platform === 'claude' && obs.kind === 'usage') {
      measures.set('uncachedInput', known(obs.uncachedInput));
      measures.set('cacheReadInput', known(obs.cacheReadInput));
      measures.set('cacheCreation5mInput', known(obs.cacheCreation5mInput));
      measures.set('cacheCreation1hInput', known(obs.cacheCreation1hInput));
      measures.set('output', known(obs.output));
      measures.set('inputTotal', known(obs.inputTotal));
      measures.set('totalTokens', known(obs.inputTotal + obs.output));
      if (obs.requests.kind === 'known') {
        measures.set('requests', known(obs.requests.value));
      }
      if (obs.webSearchRequests.kind === 'known') {
        measures.set('webSearchRequests', known(obs.webSearchRequests.value));
      }
    } else if (obs.platform === 'gemini' && obs.kind === 'usage') {
      const value = obs.tokens.kind === 'known' ? obs.tokens.value : 0;
      measures.set('tokens.input', known(obs.direction === 'input' ? value : 0));
      measures.set('tokens.output', known(obs.direction === 'output' ? value : 0));
    } else {
      measures.set('amount', known(obs.amount));
    }
    return {
      platform: obs.platform,
      group: obs.groupId,
      day: obs.period,
      week: isoWeekOf(obs.period),
      model: obs.model,
      measures,
    };
  });
}

function checkOf(
  id: string,
  deltas: readonly DeltaLine[],
  issues: readonly Issue[],
  keepAll: boolean,
): CheckResult {
  const failing = deltas.filter(lineFails);
  return {
    id,
    status: failing.length > 0 || issues.length > 0 ? 'fail' : 'pass',
    deltas: keepAll ? deltas : failing,
    issues,
  };
}

const notRun = (id: string): CheckResult => ({ id, status: 'not_run', deltas: [], issues: [] });

function rowAccountingIssues(rows: readonly DisposedRow[]): Issue[] {
  const issues: Issue[] = [];
  const acceptedKeys = new Set<string>();
  const conflictKeys = new Set<string>();
  for (const row of rows) {
    const key = row.provenance.key;
    if (row.disposition.kind === 'conflict' && key !== undefined) {
      conflictKeys.add(key);
    }
  }
  for (const row of rows) {
    if (row.disposition.kind !== 'accepted') {
      continue;
    }
    const key = row.provenance.key;
    if (key === undefined || row.step2.kind !== 'resolved') {
      issues.push({ code: 'accepted_row_not_eligible', subject: refOf(row) });
    } else if (acceptedKeys.has(key)) {
      issues.push({ code: 'duplicate_active_key', subject: sha256Hex(key) });
    } else if (conflictKeys.has(key)) {
      issues.push({ code: 'conflicted_key_accepted', subject: sha256Hex(key) });
    }
    if (key !== undefined) {
      acceptedKeys.add(key);
    }
  }
  return issues;
}

const refOf = (row: DisposedRow): string =>
  `${row.provenance.source}#${String(row.provenance.ref.rowIndex)}`;

function parityIssues(
  platform: Platform,
  rows: readonly DisposedRow[],
  canonical: readonly Observation[],
): Issue[] {
  const issues: Issue[] = [];
  const accepted = (source: RowSourceKind): number =>
    rows.filter((row) => row.provenance.source === source && row.disposition.kind === 'accepted')
      .length;
  const usage = canonical.filter((o) => o.platform === platform && o.kind === 'usage');
  const charges = canonical.filter((o) => o.platform === platform && o.kind === 'charge');
  if (platform === 'claude') {
    if (usage.length !== accepted('claude_usage')) {
      issues.push({ code: 'usage_observation_count_mismatch', subject: 'claude' });
    }
    if (charges.length !== accepted('claude_cost')) {
      issues.push({ code: 'charge_observation_count_mismatch', subject: 'claude' });
    }
  } else {
    const expected = accepted('gemini_billing');
    if (usage.length !== expected || charges.length !== expected) {
      issues.push({ code: 'gemini_observation_count_mismatch', subject: 'gemini' });
    }
  }
  return issues;
}

/** Independent raw controls vs accepted canonical observations, rollups, pairing and gaps. */
export function reconcile(input: ReconcileInput): ReconciliationReport {
  const failed = input.failedSources;
  const checks: CheckResult[] = [];
  const canonicalAll = canonicalFacts(input.canonical);

  checks.push(checkOf('row_accounting', [], rowAccountingIssues(input.rows), false));

  for (const platform of PLATFORMS) {
    const rows = input.rows.filter((row) => row.raw.platform === platform);
    const rawAll = rows.map((row) => row.raw);
    const rawExcluded = rows
      .filter((row) => row.disposition.kind !== 'accepted')
      .map((row) => row.raw);
    const rawSet = buildRollupSet(rawAll);
    const excludedSet = buildRollupSet(rawExcluded);
    const canonicalSet: RollupSet = buildRollupSet(
      canonicalAll.filter((f) => f.platform === platform),
    );

    const parityId = `${platform}.observation_parity`;
    const parityRequires: readonly RowSourceKind[] =
      platform === 'claude' ? ['claude_usage', 'claude_cost'] : ['gemini_billing'];
    checks.push(
      parityRequires.some((source) => failed.has(source))
        ? notRun(parityId)
        : checkOf(parityId, [], parityIssues(platform, rows, input.canonical), false),
    );

    for (const cls of CLASSES[platform]) {
      const include = (name: string): boolean => measureClass(name) === cls;
      const blocked = requiredSources(platform, cls).some((source) => failed.has(source));
      for (const selector of SELECTOR_NAMES) {
        const id = `${platform}.${selector}.${cls}`;
        if (blocked) {
          checks.push(notRun(id));
          continue;
        }
        const deltas = compareRollups(
          selector,
          rawSet[selector],
          excludedSet[selector],
          canonicalSet[selector],
          include,
        );
        checks.push(checkOf(id, deltas, [], selector === 'platform' || selector === 'model'));
      }
      const sumsId = `${platform}.rollup_sums.${cls}`;
      if (blocked) {
        checks.push(notRun(sumsId));
      } else {
        const issues = [
          ...rollupSumIssues(rawSet, 'raw', include),
          ...rollupSumIssues(canonicalSet, 'canonical', include),
        ];
        checks.push(checkOf(sumsId, [], issues, false));
      }
    }
  }

  const pairingId = 'claude.pairing';
  if (failed.has('claude_usage') || failed.has('claude_cost')) {
    checks.push(notRun(pairingId));
  } else {
    const pairingRows: PairingRow[] = [];
    for (const row of input.rows) {
      const source = row.provenance.source;
      if ((source === 'claude_usage' || source === 'claude_cost') && row.raw.claudePairing) {
        pairingRows.push({
          source,
          accepted: row.disposition.kind === 'accepted',
          pairing: row.raw.claudePairing,
        });
      }
    }
    checks.push(checkOf(pairingId, [], pairingIssues(pairingRows), false));
  }

  const gaps: GapReport[] = [];
  for (const platform of PLATFORMS) {
    const sources: readonly RowSourceKind[] =
      platform === 'claude' ? ['claude_usage', 'claude_cost'] : ['gemini_billing'];
    if (sources.some((source) => failed.has(source))) {
      gaps.push({ platform, status: 'not_run', sourceDays: 0, missingDays: [] });
      continue;
    }
    const days: string[] = [];
    for (const row of input.rows) {
      if (
        row.raw.platform === platform &&
        row.disposition.kind === 'accepted' &&
        row.raw.day !== undefined
      ) {
        days.push(row.raw.day);
      }
    }
    gaps.push(detectGaps(platform, days, input.expectedWindows?.[platform]));
  }

  return {
    checks: checks.sort((a, b) => compareStrings(a.id, b.id)),
    gaps,
  };
}
