import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateProvisioning } from '../scripts/provisioning-validation.js';

describe('provisioning validation', () => {
  it('passes for dev, staging and prod', () => {
    expect(validateProvisioning()).toEqual([]);
  });

  it('fails closed when an environment cannot be provisioned', () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-validate-bad-'));
    try {
      mkdirSync(join(root, 'generated'));
      writeFileSync(join(root, 'generated', 'dev'), 'not a directory');
      const problems = validateProvisioning(root);
      expect(problems.some((problem) => problem.startsWith('dev:'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
