import { describe, expect, it } from 'vitest';
import { finalizeRun, ingest, processArtifacts } from '../../src/ingest/ingest.js';
import { computeRunStatus } from '../../src/reconcile/status.js';
import {
  bytesOf,
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  withFields,
} from './fixture-helpers.js';

describe('run status', () => {
  it('S1: directory failure is blocked', () => {
    expect(ingest(fixtureArtifacts({ groups: bytesOf('nope') })).report.status).toBe('blocked');
    expect(
      computeRunStatus({ directoryFailed: true, sourceFailures: 3, exclusions: 3, checks: [] }),
    ).toBe('blocked');
  });

  it('S2: a source file failure is partial', () => {
    expect(ingest(fixtureArtifacts({ claudeCost: bytesOf('[]') })).report.status).toBe('partial');
  });

  it('S3: exclusions with successful reconciliation are complete_with_exclusions', () => {
    const usage = claudeRows(FIXTURE.claudeUsage);
    const cases = [
      claudeBytes([...usage, first(usage)]),
      claudeBytes([withFields(first(usage), { total_tokens: 1 }), ...usage.slice(1)]),
      claudeBytes([...usage, withFields(first(usage), { output_tokens: 1, total_tokens: 1 })]),
    ];
    for (const claudeUsage of cases) {
      expect(ingest(fixtureArtifacts({ claudeUsage })).report.status).toBe(
        'complete_with_exclusions',
      );
    }
  });

  it('S4: the supplied fixture is complete with no exclusions', () => {
    const { report } = ingest(fixtureArtifacts());
    expect(report.status).toBe('complete');
    expect(report.counts).toMatchObject({
      rows: 4174,
      duplicates: 0,
      conflicts: 0,
      restatements: 0,
      quarantined: 0,
    });
    expect(report.sourceFailures).toEqual([]);
    expect(report.reconciliation.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(report.reconciliation.gaps.some((g) => g.missingDays.length > 0)).toBe(true);
  });

  it('S5: a failed integrity check can never be complete', () => {
    const data = processArtifacts(fixtureArtifacts());
    const tampered = data.canonical.slice(1);
    expect(finalizeRun(data, {}, tampered).report.status).toBe('failed');
    const failing = { id: 'x', status: 'fail' as const, deltas: [], issues: [] };
    for (const exclusions of [0, 5]) {
      expect(
        computeRunStatus({
          directoryFailed: false,
          sourceFailures: 0,
          exclusions,
          checks: [failing],
        }),
      ).toBe('failed');
    }
  });
});
