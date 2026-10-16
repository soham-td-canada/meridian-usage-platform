import { describe, expect, it } from 'vitest';

describe('repository foundation', () => {
  it('supports exact bigint arithmetic', () => {
    expect(889_000_500n + 1n).toBe(889_000_501n);
  });
});
