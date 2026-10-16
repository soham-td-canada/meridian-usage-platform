import { describe, expect, it } from 'vitest';
import { finalizeRun, ingest, processArtifacts } from '../../src/ingest/ingest.js';
import type { ActiveRow, IngestionState, RawArtifact } from '../../src/ingest/types.js';
import {
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  geminiBytes,
  geminiLines,
  isRecord,
  pairKeyOf,
  withFields,
  type JsonRecord,
} from './fixture-helpers.js';

const usageRows = claudeRows(FIXTURE.claudeUsage);
const costRows = claudeRows(FIXTURE.claudeCost);
const BASELINE = ingest(fixtureArtifacts());

function rebuildPriorState(state: IngestionState): IngestionState {
  const activeEntries = [...state.active.entries()]
    .map(([keyDigest, row]): readonly [string, ActiveRow] => [
      keyDigest,
      {
        keyDigest: row.keyDigest,
        source: row.source,
        fingerprint: row.fingerprint,
        artifactSha256: row.artifactSha256,
        directorySha256: row.directorySha256,
        ref: { source: row.ref.source, rowIndex: row.ref.rowIndex },
        observations: row.observations.map((observation) => structuredClone(observation)),
      },
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    active: new Map(activeEntries),
    artifacts: state.artifacts.map((artifact) => ({ ...artifact })),
  };
}

const withUsage = (rows: readonly JsonRecord[]) =>
  ingest(fixtureArtifacts({ claudeUsage: claudeBytes(rows) }));

const noFailedChecks = (result: ReturnType<typeof ingest>): void => {
  expect(result.report.reconciliation.checks.filter((c) => c.status === 'fail')).toEqual([]);
};

const bump = (row: JsonRecord, by: number): JsonRecord => {
  const output = row['output_tokens'];
  const total = row['total_tokens'];
  if (typeof output !== 'number' || typeof total !== 'number') {
    throw new Error('unexpected fixture shape');
  }
  return withFields(row, { output_tokens: output + by, total_tokens: total + by });
};

describe('duplicate and conflict handling', () => {
  it('D1: identical duplicate is counted once', () => {
    const result = withUsage([...usageRows, first(usageRows)]);
    expect(result.report.counts.accepted).toBe(BASELINE.report.counts.accepted);
    expect(result.report.counts.duplicates).toBe(1);
    expect(result.report.status).toBe('complete_with_exclusions');
    expect(result.state.active.size).toBe(BASELINE.state.active.size);
    noFailedChecks(result);
    const totals = (r: ReturnType<typeof ingest>) =>
      r.report.reconciliation.checks.find((c) => c.id === 'claude.platform.tokens')?.deltas;
    expect(totals(result)?.map((d) => d.canonical)).toEqual(
      totals(BASELINE)?.map((d) => d.canonical),
    );
  });

  it('D2: conflicting duplicate excludes every version', () => {
    const result = withUsage([...usageRows, bump(first(usageRows), 1)]);
    expect(result.report.counts.conflicts).toBe(2);
    expect(result.report.counts.accepted).toBe(BASELINE.report.counts.accepted - 1);
    expect(result.state.active.size).toBe(BASELINE.state.active.size - 1);
    expect(result.report.status).toBe('complete_with_exclusions');
    noFailedChecks(result);
  });

  it('D3: three-way conflict has no ordering winner', () => {
    const rows = [first(usageRows), bump(first(usageRows), 1), bump(first(usageRows), 2)];
    const forward = withUsage([...rows, ...usageRows.slice(1)]);
    const reversed = withUsage([...usageRows.slice(1), ...[...rows].reverse()]);
    expect(forward.report.counts.conflicts).toBe(3);
    expect(reversed.report.counts.conflicts).toBe(3);
    expect([...forward.state.active.keys()]).toEqual([...reversed.state.active.keys()]);
    noFailedChecks(forward);
  });

  it('D4: a valid and a rejected row sharing a key conflict', () => {
    const invalid = withFields(first(usageRows), { total_tokens: 1 });
    const result = withUsage([...usageRows, invalid]);
    const conflicts = result.report.rows.filter((row) => row.disposition.kind === 'conflict');
    expect(conflicts).toHaveLength(2);
    expect(result.report.counts.quarantined).toBe(0);
    expect(result.state.active.size).toBe(BASELINE.state.active.size - 1);
    noFailedChecks(result);
  });
});

describe('replay and restatement', () => {
  it('C2: digest-keyed prior state rebuild replays identically', () => {
    const rebuilt = rebuildPriorState(BASELINE.state);
    expect([...rebuilt.active.keys()]).toEqual([...BASELINE.state.active.keys()]);
    expect(
      [...rebuilt.active.entries()].every(
        ([keyDigest, row]) => row.keyDigest === keyDigest && keyDigest.length === 64,
      ),
    ).toBe(true);
    const replay = ingest(fixtureArtifacts(), rebuilt);
    expect(replay.report.counts.accepted).toBe(0);
    expect(replay.report.counts.replayed).toBe(BASELINE.report.counts.accepted);
    expect(replay.report.counts.restatements).toBe(0);
    expect(replay.report.counts.priorKeysAbsent).toBe(0);
    expect(replay.state.active).toEqual(BASELINE.state.active);
  });

  it('R1: exact replay is deterministic and adds nothing', () => {
    expect(ingest(fixtureArtifacts())).toEqual(BASELINE);
    const replay = ingest(fixtureArtifacts(), BASELINE.state);
    expect(replay.state.active).toEqual(BASELINE.state.active);
    expect(replay.report.counts.replayed).toBe(BASELINE.report.counts.accepted);
    expect(replay.report.counts.accepted).toBe(0);
    expect(replay.report.status).toBe('complete');
    expect(replay.report.reconciliation).toEqual(BASELINE.report.reconciliation);
  });

  it('R2: row order does not matter', () => {
    const shuffled = withUsage([...usageRows].reverse());
    expect([...shuffled.state.active.entries()].map(([k, v]) => [k, v.fingerprint])).toEqual(
      [...BASELINE.state.active.entries()].map(([k, v]) => [k, v.fingerprint]),
    );
    expect(shuffled.report.reconciliation).toEqual(BASELINE.report.reconciliation);
    expect(shuffled.report.status).toBe('complete');
    const withDuplicates = [...usageRows, bump(first(usageRows), 1)];
    const a = withUsage(withDuplicates);
    const b = withUsage([...withDuplicates].reverse());
    expect(a.report.counts).toEqual(b.report.counts);
    expect([...a.state.active.keys()]).toEqual([...b.state.active.keys()]);
  });

  it('R3: artifact order does not matter', () => {
    const artifacts = fixtureArtifacts();
    const reordered: RawArtifact[] = [...artifacts].reverse();
    expect(ingest(reordered)).toEqual(BASELINE);
    expect(ingest([...artifacts, ...artifacts])).toEqual(BASELINE);
  });

  it('R4: a restated row never replaces the prior active value', () => {
    const lines = geminiLines(FIXTURE.gemini);
    const restated = [
      first(lines).replace('"cost": 0.107564', '"cost": 0.107565'),
      ...lines.slice(1),
    ];
    expect(restated[0]).not.toBe(lines[0]);
    const result = ingest(fixtureArtifacts({ gemini: geminiBytes(restated) }), BASELINE.state);
    expect(result.report.counts.restatements).toBe(1);
    expect(result.report.status).toBe('complete_with_exclusions');
    expect(result.state.active).toEqual(BASELINE.state.active);
    noFailedChecks(result);
    const delta = result.report.reconciliation.checks
      .find((c) => c.id === 'gemini.platform.money')
      ?.deltas.at(0);
    expect(delta?.excluded).toBe(10756500n);
  });

  it('R5: absence from a later artifact never deletes', () => {
    const key = pairKeyOf(first(usageRows, usageRows.length - 1));
    const data = processArtifacts(
      fixtureArtifacts({
        claudeUsage: claudeBytes(usageRows.filter((row) => pairKeyOf(row) !== key)),
        claudeCost: claudeBytes(costRows.filter((row) => pairKeyOf(row) !== key)),
      }),
      BASELINE.state,
    );
    expect(data.priorKeysAbsent).toBeGreaterThan(0);
    expect(data.state.active).toEqual(BASELINE.state.active);
    const result = finalizeRun(data);
    expect(result.report.status).toBe('complete');
    expect(result.report.counts.restatements).toBe(0);
  });

  it('R5: a counterpart missing from only one file is visible, and prior state is intact', () => {
    const key = pairKeyOf(first(usageRows, usageRows.length - 1));
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes(costRows.filter((r) => pairKeyOf(r) !== key)) }),
      BASELINE.state,
    );
    expect(result.report.status).toBe('failed');
    const pairing = result.report.reconciliation.checks.find((c) => c.id === 'claude.pairing');
    expect(pairing?.status).toBe('fail');
    expect(pairing?.issues.map((i) => i.code)).toContain('usage_missing_tokens_charge');
    expect(pairing?.issues.every((i) => i.subject === key)).toBe(true);
    expect(result.state.active).toEqual(BASELINE.state.active);
  });

  it('R1: exact replay leaves state.active unchanged, including order and provenance', () => {
    const replay = ingest([...fixtureArtifacts()].reverse(), BASELINE.state);
    expect([...replay.state.active.keys()]).toEqual([...BASELINE.state.active.keys()]);
    for (const [key, row] of BASELINE.state.active) {
      expect(replay.state.active.get(key)).toBe(row);
      expect(row.keyDigest).toBe(key);
    }
    expect(replay.state.artifacts).toEqual(BASELINE.state.artifacts);
    expect(replay.report.rows.every((row) => row.disposition.kind === 'accepted')).toBe(true);
  });

  it('R1: replay under a byte-different but equivalent directory stays a replay', () => {
    const groups = new TextDecoder().decode(FIXTURE.groups);
    const reformatted = new TextEncoder().encode(`${groups}\n`);
    const replay = ingest(fixtureArtifacts({ groups: reformatted }), BASELINE.state);
    expect(replay.report.counts.replayed).toBe(BASELINE.report.counts.accepted);
    expect(replay.report.counts.restatements).toBe(0);
    expect(replay.state.active).toEqual(BASELINE.state.active);
  });

  it('observation equality ignores property insertion order', () => {
    const reordered = new Map(
      [...BASELINE.state.active].map(([key, row]) => [
        key,
        {
          ...row,
          observations: row.observations.map(({ model, ...rest }) => ({ ...rest, model })),
        },
      ]),
    );
    const replay = ingest(fixtureArtifacts(), { ...BASELINE.state, active: reordered });
    expect(replay.report.counts.replayed).toBe(BASELINE.report.counts.accepted);
    expect(replay.report.counts.restatements).toBe(0);
  });

  it('a directory change that alters attribution is a distinct directory_changed restatement', () => {
    const doc: unknown = JSON.parse(new TextDecoder().decode(FIXTURE.groups));
    if (!isRecord(doc) || !Array.isArray(doc['groups'])) {
      throw new Error('bad groups fixture');
    }
    const [a, b] = doc['groups'].filter(isRecord);
    if (a === undefined || b === undefined) {
      throw new Error('need two groups');
    }
    const rbacA = a['claude_rbac_group_id'];
    a['claude_rbac_group_id'] = b['claude_rbac_group_id'];
    b['claude_rbac_group_id'] = rbacA;
    const result = ingest(
      fixtureArtifacts({ groups: new TextEncoder().encode(JSON.stringify(doc)) }),
      BASELINE.state,
    );
    const restated = result.report.rows.filter((row) => row.disposition.kind === 'restatement');
    expect(restated.length).toBeGreaterThan(0);
    expect(
      restated.every(
        (row) =>
          row.disposition.kind === 'restatement' && row.disposition.reason === 'directory_changed',
      ),
    ).toBe(true);
    expect(result.state.active).toEqual(BASELINE.state.active);
    expect(result.report.status).toBe('complete_with_exclusions');
    noFailedChecks(result);
  });

  it('an observation change under an unchanged directory is observation_changed', () => {
    const entry = [...BASELINE.state.active].find(([, row]) =>
      row.observations.some((o) => o.kind === 'charge'),
    );
    if (entry === undefined) {
      throw new Error('no charge row');
    }
    const [key, row] = entry;
    const prior = new Map(BASELINE.state.active).set(key, {
      ...row,
      observations: row.observations.map((o) =>
        o.kind === 'charge' ? { ...o, amount: o.amount + 1n } : o,
      ),
    });
    const result = ingest(fixtureArtifacts(), { ...BASELINE.state, active: prior });
    const restated = result.report.rows.filter((r) => r.disposition.kind === 'restatement');
    expect(restated.map((r) => r.disposition)).toEqual([
      { kind: 'restatement', reason: 'observation_changed' },
    ]);
    expect(result.state.active.get(key)).toBe(prior.get(key));
  });
});
