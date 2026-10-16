import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/ingest/ingest.js';
import {
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  pairKeyOf,
  withFields,
} from './fixture-helpers.js';

const usage = claudeRows(FIXTURE.claudeUsage);
const costs = claudeRows(FIXTURE.claudeCost);
const pairing = (result: ReturnType<typeof ingest>) =>
  result.report.reconciliation.checks.find((c) => c.id === 'claude.pairing');

describe('X5: Claude usage/cost pairing', () => {
  it('matches the fixture shape', () => {
    expect(usage).toHaveLength(1346);
    expect(costs.filter((r) => r['cost_type'] === 'tokens')).toHaveLength(1346);
    expect(costs.filter((r) => r['cost_type'] === 'web_search')).toHaveLength(492);
    expect(
      usage.filter((r) => {
        const tool = r['server_tool_use'];
        return typeof tool === 'object' && tool !== null && 'web_search_requests' in tool
          ? Number(tool.web_search_requests) > 0
          : false;
      }),
    ).toHaveLength(492);
  });

  it('passes with no orphans and agreeing raw fields', () => {
    const result = ingest(fixtureArtifacts());
    expect(pairing(result)?.status).toBe('pass');
    expect(pairing(result)?.issues).toEqual([]);
  });

  it('fails on an unexplained missing tokens charge', () => {
    const target = first(costs.filter((r) => r['cost_type'] === 'tokens'));
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes(costs.filter((r) => r !== target)) }),
    );
    expect(pairing(result)?.issues.map((i) => i.code)).toEqual(['usage_missing_tokens_charge']);
    expect(result.report.status).toBe('failed');
  });

  it('fails on a charge without usage', () => {
    const target = first(usage);
    const result = ingest(
      fixtureArtifacts({ claudeUsage: claudeBytes(usage.filter((r) => r !== target)) }),
    );
    expect(pairing(result)?.status).toBe('fail');
    expect(pairing(result)?.issues.map((i) => i.code)).toContain('tokens_charge_without_usage');
  });

  it('fails when paired raw requests disagree', () => {
    const target = first(costs);
    const result = ingest(
      fixtureArtifacts({
        claudeCost: claudeBytes(
          costs.map((r) => (r === target ? withFields(r, { requests: 99 }) : r)),
        ),
      }),
    );
    expect(pairing(result)?.issues.map((i) => i.code)).toContain('paired_requests_mismatch');
  });

  it('explains a charge excluded for an rbac group mismatch', () => {
    const target = first(costs);
    const swapped = withFields(target, { rbac_group_id: 'rbac_group_OTHER' });
    const result = ingest(
      fixtureArtifacts({ claudeCost: claudeBytes(costs.map((r) => (r === target ? swapped : r))) }),
    );
    // The row becomes unresolved (excluded), so the missing charge is explained, not an orphan.
    expect(pairing(result)?.status).toBe('pass');
    expect(result.report.status).toBe('complete_with_exclusions');
  });

  it('explains orphans caused by excluded counterparts', () => {
    const key = pairKeyOf(first(usage));
    const broken = usage.map((r) =>
      pairKeyOf(r) === key ? withFields(r, { total_tokens: 1 }) : r,
    );
    const result = ingest(fixtureArtifacts({ claudeUsage: claudeBytes(broken) }));
    expect(pairing(result)?.status).toBe('pass');
    expect(result.report.status).toBe('complete_with_exclusions');
  });
});
