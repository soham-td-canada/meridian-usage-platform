import { describe, expect, it } from 'vitest';
import {
  artifactOf,
  directoryArtifactOf,
  rowFingerprint,
  sourceKeyOf,
} from '../../src/ingest/identity.js';
import { ingest } from '../../src/ingest/ingest.js';
import { parseLexicalJson } from '../../src/raw/lexical-json.js';
import {
  bytesOf,
  claudeBytes,
  claudeRows,
  first,
  FIXTURE,
  fixtureArtifacts,
  geminiLines,
  withFields,
} from './fixture-helpers.js';

describe('I1: artifact identity', () => {
  it('is stable for identical bytes and changes with one byte', () => {
    const a = artifactOf('claude_usage', FIXTURE.claudeUsage);
    const b = artifactOf('claude_usage', new Uint8Array(FIXTURE.claudeUsage));
    expect(a).toEqual(b);
    const changed = new Uint8Array(FIXTURE.claudeUsage);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(artifactOf('claude_usage', changed).sha256).not.toBe(a.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes bytes only; identity is the (source kind, sha) pair', () => {
    expect(artifactOf('claude_cost', FIXTURE.claudeUsage).sha256).toBe(
      artifactOf('claude_usage', FIXTURE.claudeUsage).sha256,
    );
    expect(artifactOf('claude_cost', FIXTURE.claudeUsage).source).toBe('claude_cost');
    expect(directoryArtifactOf(FIXTURE.users, FIXTURE.groups)).toEqual(
      directoryArtifactOf(FIXTURE.users, FIXTURE.groups),
    );
  });
});

describe('I2: source row keys', () => {
  const usage = first(claudeRows(FIXTURE.claudeUsage));
  const cost = first(claudeRows(FIXTURE.claudeCost));
  const node = (value: unknown) => parseLexicalJson(JSON.stringify(value));

  it('extracts Claude usage and cost keys including source-only dimensions', () => {
    const usageKey = sourceKeyOf('claude_usage', node(usage));
    const costKey = sourceKeyOf('claude_cost', node(cost));
    expect(usageKey).toContain('"user_E7691888F28227066DD2FB86"');
    expect(usageKey).toContain('"global"');
    expect(usageKey).toContain('"standard"');
    expect(costKey).toContain('"tokens"');
    expect(sourceKeyOf('claude_usage', node(withFields(usage, { speed: 'fast' })))).not.toBe(
      usageKey,
    );
    expect(sourceKeyOf('claude_cost', node(withFields(cost, { amount: '9.000000' })))).toBe(
      costKey,
    );
  });

  it('keys Gemini rows without cost, export_time or invoice.month', () => {
    const line = first(geminiLines(FIXTURE.gemini));
    const original = sourceKeyOf('gemini_billing', parseLexicalJson(line));
    const altered = line
      .replace('"cost": 0.107564', '"cost": 9.5')
      .replace('2026-08-06 03:41:17.882 UTC', '2030-01-01 00:00:00.000 UTC')
      .replace('"202608"', '"209901"');
    expect(altered).not.toBe(line);
    expect(sourceKeyOf('gemini_billing', parseLexicalJson(altered))).toBe(original);
    expect(original).toContain('01A2B3-C4D5E6-F7A8B9');
    expect(original).toContain('site-monitoring-assistant');
  });
});

describe('I3: missing key components', () => {
  it('quarantines the row by SourceRef and never deduplicates it', () => {
    const rows = claudeRows(FIXTURE.claudeUsage);
    const broken = { ...first(rows) };
    delete broken['speed'];
    const result = ingest(fixtureArtifacts({ claudeUsage: claudeBytes([broken, broken]) }));
    const quarantined = result.report.rows.filter(
      (row) => row.provenance.source === 'claude_usage',
    );
    expect(quarantined).toHaveLength(2);
    for (const row of quarantined) {
      expect(row.provenance.keyDigest).toBeUndefined();
      expect(row.disposition).toEqual({
        kind: 'quarantined',
        reason: { kind: 'key_unextractable' },
      });
    }
    expect(quarantined.map((row) => row.provenance.ref.rowIndex)).toEqual([0, 1]);
    expect(result.report.counts.duplicates).toBe(0);
  });
});

describe('I4: fingerprints', () => {
  const fingerprint = (text: string): string => rowFingerprint(parseLexicalJson(text));

  it('ignores key order and insignificant whitespace', () => {
    expect(fingerprint('{"a": 1, "b": {"c": [1, 2], "d": "x"}}')).toBe(
      fingerprint('{ "b":{"d":"x","c":[1,2]},\n "a":1 }'),
    );
  });

  it('preserves numeric lexemes', () => {
    expect(fingerprint('{"cost": 0.107564}')).not.toBe(fingerprint('{"cost": 0.1075640}'));
  });

  it('does not use normalized observations', () => {
    expect(fingerprint('{"x":"a"}')).not.toBe(fingerprint('{"x":"b"}'));
    expect(bytesOf('x').length).toBe(1);
  });
});
