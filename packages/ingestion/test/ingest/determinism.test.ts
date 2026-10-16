import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ingest } from '../../src/ingest/ingest.js';
import { fixtureArtifacts } from './fixture-helpers.js';

const STARTER_KIT = new URL('../../../../starter-kit/', import.meta.url);

function hashTree(dir: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const child = new URL(name, dir);
    if (statSync(child).isDirectory()) {
      const nested = hashTree(new URL(`${name}/`, dir));
      for (const [path, hash] of Object.entries(nested)) {
        out[`${name}/${path}`] = hash;
      }
    } else {
      out[name] = createHash('sha256').update(readFileSync(child)).digest('hex');
    }
  }
  return out;
}

describe('determinism', () => {
  it('is identical across repeated runs and host timezones', () => {
    const baseline = ingest(fixtureArtifacts());
    const original = process.env['TZ'];
    try {
      for (const zone of ['America/Toronto', 'Asia/Kolkata', 'Pacific/Kiritimati', 'UTC']) {
        process.env['TZ'] = zone;
        expect(ingest(fixtureArtifacts())).toEqual(baseline);
      }
    } finally {
      if (original === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = original;
      }
    }
  });

  it('orders row reports and checks stably', () => {
    const { report } = ingest(fixtureArtifacts());
    const ids = report.reconciliation.checks.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    const keys = report.rows.map(
      (r) => `${r.provenance.artifactSha256}:${String(r.provenance.ref.rowIndex).padStart(8, '0')}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never modifies starter-kit files', () => {
    const before = hashTree(STARTER_KIT);
    ingest(fixtureArtifacts());
    expect(hashTree(STARTER_KIT)).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(5);
  });
});
