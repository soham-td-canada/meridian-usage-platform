import { describe, expect, it } from 'vitest';
import * as publicApi from '../../src/index.js';
import { ingest } from '../../src/ingest/ingest.js';
import {
  bytesOf,
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  textOf,
  withFields,
} from './fixture-helpers.js';

const usage = claudeRows(FIXTURE.claudeUsage);
const costs = claudeRows(FIXTURE.claudeCost);
const WINDOW = { start: '2026-08-03', end: '2026-09-27' };
const checkOf = (result: ReturnType<typeof ingest>, id: string) =>
  result.report.reconciliation.checks.find((c) => c.id === id);

describe('status precedence', () => {
  it('a fatal reconciliation failure wins over a source failure', () => {
    const result = ingest(
      fixtureArtifacts({ claudeUsage: claudeBytes(usage.slice(1)) }).filter(
        (a) => a.source !== 'gemini_billing',
      ),
    );
    expect(result.report.sourceFailures.map((f) => f.code)).toEqual(['artifact_missing']);
    expect(checkOf(result, 'claude.pairing')?.status).toBe('fail');
    expect(checkOf(result, 'gemini.platform.money')?.status).toBe('not_run');
    expect(result.report.status).toBe('failed');
  });

  it('a source failure alone is partial and creates no failed check', () => {
    const result = ingest(fixtureArtifacts().filter((a) => a.source !== 'gemini_billing'));
    expect(result.report.status).toBe('partial');
    expect(result.report.reconciliation.checks.some((c) => c.status === 'fail')).toBe(false);
  });
});

describe('report retention', () => {
  it('exposes only provenance and disposition on every row', () => {
    const quarantined = withFields(first(costs), { rbac_group_id: 'rbac_group_UNKNOWN' });
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes([quarantined, ...costs.slice(1)]) }),
    );
    expect(result.report.counts.quarantined).toBe(1);
    for (const row of result.report.rows) {
      expect(Object.keys(row).sort()).toEqual(['disposition', 'provenance']);
      expect(Object.keys(row.provenance).sort()).toEqual([
        'artifactSha256',
        'fingerprint',
        'keyDigest',
        'ref',
        'source',
      ]);
    }
    const text = JSON.stringify(result.report.rows);
    expect(text).not.toContain('@');
    expect(text).not.toContain('rbac_group_UNKNOWN');
  });

  it('keeps finalizeRun and the canonical override out of the public API', () => {
    expect('ingest' in publicApi).toBe(true);
    for (const internal of ['finalizeRun', 'processArtifacts', 'disposeRows', 'reconcile']) {
      expect(internal in publicApi).toBe(false);
    }
  });

  it('returns a fixed directory failure message', () => {
    const result = ingest(fixtureArtifacts({ groups: bytesOf('{"groups": [ SECRET') }));
    expect(result.report.status).toBe('blocked');
    expect(result.report.directoryFailure?.message).toBe('directory files are invalid');
  });
});

describe('source failures and state artifacts', () => {
  it('treats a zero-row Gemini file as a source failure, never a clean source', () => {
    {
      const result = ingest(fixtureArtifacts({ gemini: bytesOf('') }));
      expect(result.report.status).toBe('partial');
      expect(result.report.sourceFailures.map((f) => [f.source, f.code])).toEqual([
        ['gemini_billing', 'file_invalid'],
      ]);
      expect(checkOf(result, 'gemini.platform.money')?.status).toBe('not_run');
      expect(result.report.reconciliation.gaps[1]?.status).toBe('not_run');
    }
  });

  it('records only successfully parsed artifacts in state', () => {
    const torn = ingest(
      fixtureArtifacts({ gemini: bytesOf(textOf(FIXTURE.gemini).slice(0, -40)) }),
    );
    expect(torn.report.artifacts.some((a) => a.source === 'gemini_billing')).toBe(true);
    expect(torn.state.artifacts.some((a) => a.source === 'gemini_billing')).toBe(false);
    expect(torn.state.artifacts.some((a) => a.source === 'claude_usage')).toBe(true);
  });
});

describe('gap coverage', () => {
  const claudeWithout = (day: string) =>
    ingest(
      fixtureArtifacts({
        claudeUsage: claudeBytes(usage.filter((r) => !String(r['starting_at']).startsWith(day))),
        claudeCost: claudeBytes(costs.filter((r) => !String(r['starting_at']).startsWith(day))),
      }),
      undefined,
      { expectedWindows: { claude: WINDOW } },
    );

  it('detects a missing trailing day against the expected window', () => {
    const result = claudeWithout('2026-09-27');
    expect(result.report.reconciliation.gaps[0]).toMatchObject({
      status: 'evaluated',
      sourceDays: 55,
      missingDays: ['2026-09-27'],
    });
  });

  it('does not count days covered only by excluded rows', () => {
    const day = '2026-09-27';
    const onDay = (r: Record<string, unknown>): boolean => String(r['starting_at']).startsWith(day);
    const brokenUsage = usage.filter(onDay).map((r) => withFields(r, { total_tokens: 1 }));
    const brokenCosts = costs.filter(onDay).map((r) => withFields(r, { amount: 'bad' }));
    const result = ingest(
      fixtureArtifacts({
        claudeUsage: claudeBytes([...usage.filter((r) => !onDay(r)), ...brokenUsage]),
        claudeCost: claudeBytes([...costs.filter((r) => !onDay(r)), ...brokenCosts]),
      }),
      undefined,
      { expectedWindows: { claude: WINDOW } },
    );
    expect(result.report.counts.quarantined).toBeGreaterThan(0);
    expect(result.report.reconciliation.gaps[0]?.missingDays).toEqual([day]);
  });

  it('is not_run for a platform whose source failed or is missing', () => {
    const result = ingest(fixtureArtifacts({ claudeCost: bytesOf('[]') }).slice(0, 3), undefined, {
      expectedWindows: { claude: WINDOW, gemini: WINDOW },
    });
    expect(result.report.reconciliation.gaps.map((g) => [g.platform, g.status])).toEqual([
      ['claude', 'not_run'],
      ['gemini', 'not_run'],
    ]);
  });
});

describe('pairing attribution', () => {
  it('an unkeyed excluded row does not suppress real orphans', () => {
    const target = first(costs.filter((r) => r['cost_type'] === 'tokens'));
    const unkeyed = withFields(target, { actor: { email: 'nobody@example.test' } });
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes(costs.map((r) => (r === target ? unkeyed : r))) }),
    );
    expect(result.report.counts.quarantined).toBe(1);
    const pairing = checkOf(result, 'claude.pairing');
    expect(pairing?.status).toBe('fail');
    expect(pairing?.issues.map((i) => i.code)).toEqual(['usage_missing_tokens_charge']);
    expect(result.report.status).toBe('failed');
  });
});
