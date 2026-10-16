import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/ingest/ingest.js';
import { bytesOf, FIXTURE, fixtureArtifacts, textOf } from './fixture-helpers.js';

const statusOf = (result: ReturnType<typeof ingest>, id: string) =>
  result.report.reconciliation.checks.find((c) => c.id === id)?.status;

describe('file-level failures', () => {
  it('F1: a malformed directory blocks ingestion', () => {
    const result = ingest(fixtureArtifacts({ users: bytesOf('{"users": [') }));
    expect(result.report.status).toBe('blocked');
    expect(result.report.rows).toEqual([]);
    expect(result.state.active.size).toBe(0);
    expect(result.report.directoryFailure?.source).toBe('directory');
  });

  it('F1: a missing directory blocks ingestion', () => {
    const artifacts = fixtureArtifacts().filter((a) => a.source !== 'directory');
    expect(ingest(artifacts).report.status).toBe('blocked');
  });

  it('F2: a malformed Claude usage file is partial and pairing is not_run', () => {
    const truncated = bytesOf(textOf(FIXTURE.claudeUsage).slice(0, 5000));
    const result = ingest(fixtureArtifacts({ claudeUsage: truncated }));
    expect(result.report.status).toBe('partial');
    expect(result.report.sourceFailures.map((f) => f.source)).toEqual(['claude_usage']);
    expect(statusOf(result, 'claude.pairing')).toBe('not_run');
    expect(statusOf(result, 'claude.platform.tokens')).toBe('not_run');
    expect(statusOf(result, 'claude.platform.money')).toBe('pass');
    expect(statusOf(result, 'gemini.platform.money')).toBe('pass');
    expect(result.state.active.size).toBeGreaterThan(0);
  });

  it('F2: an envelope without data is a file-level failure', () => {
    const result = ingest(fixtureArtifacts({ claudeCost: bytesOf('{"rows": []}') }));
    expect(result.report.status).toBe('partial');
    expect(statusOf(result, 'claude.pairing')).toBe('not_run');
  });

  it('F3: a torn Gemini JSONL line fails the whole Gemini file', () => {
    const torn = bytesOf(textOf(FIXTURE.gemini).slice(0, -40));
    const result = ingest(fixtureArtifacts({ gemini: torn }));
    expect(result.report.status).toBe('partial');
    expect(result.report.sourceFailures[0]?.code).toBe('torn_line');
    expect(result.report.rows.some((row) => row.provenance.source === 'gemini_billing')).toBe(
      false,
    );
    for (const check of result.report.reconciliation.checks) {
      if (check.id.startsWith('gemini.')) {
        expect(check.status).toBe('not_run');
      }
    }
    expect(statusOf(result, 'claude.pairing')).toBe('pass');
  });

  it('treats a missing source artifact as a failure, never a pass', () => {
    const artifacts = fixtureArtifacts().filter((a) => a.source !== 'gemini_billing');
    const result = ingest(artifacts);
    expect(result.report.status).toBe('partial');
    expect(statusOf(result, 'gemini.platform.money')).toBe('not_run');
  });
});
