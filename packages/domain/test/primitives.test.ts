import { describe, expect, it } from 'vitest';
import { knownCount, UNAVAILABLE } from '../src/count.js';
import { parseModelName, parseProductName, parseWorkloadName } from '../src/dimensions.js';
import { isoWeekOf, utcDayContaining, utcDayFromBounds } from '../src/time.js';

const DAY_MS = 86_400_000;
const epoch = (iso: string): number => Date.parse(iso);

describe('ISO week assignment (T3)', () => {
  const weekOf = (iso: string): string => isoWeekOf(utcDayContaining(epoch(iso)));

  it.each([
    ['2026-08-03', '2026-W32'],
    ['2026-08-09T23:59:59Z', '2026-W32'],
    ['2026-08-10', '2026-W33'],
    ['2026-09-27', '2026-W39'],
    ['2026-09-28', '2026-W40'],
  ])('assigns %s to %s', (input, expected) => {
    expect(weekOf(input)).toBe(expected);
  });

  it('uses the ISO year for dates near the new year', () => {
    expect(weekOf('2026-01-01')).toBe('2026-W01');
    expect(weekOf('2025-12-29')).toBe('2026-W01');
    expect(weekOf('2027-01-03')).toBe('2026-W53');
  });
});

describe('UtcDay bounds', () => {
  it('accepts a UTC midnight to next midnight span', () => {
    const start = epoch('2026-08-04T00:00:00.000Z');
    expect(utcDayFromBounds(start, start + DAY_MS)).toEqual({ ok: true, value: '2026-08-04' });
  });

  it('rejects spans that are not exactly 24 hours', () => {
    const start = epoch('2026-08-04T00:00:00.000Z');
    expect(utcDayFromBounds(start, start + DAY_MS + 1000).ok).toBe(false);
    expect(utcDayFromBounds(start, start).ok).toBe(false);
  });

  it('keys a 24h interval that starts mid-day by its UTC start date', () => {
    const start = epoch('2026-08-04T01:00:00.000Z');
    expect(utcDayFromBounds(start, start + DAY_MS)).toEqual({ ok: true, value: '2026-08-04' });
  });

  it('rejects non-integer epoch values', () => {
    expect(utcDayFromBounds(Number.NaN, Number.NaN).ok).toBe(false);
  });
});

describe('Count', () => {
  it('keeps zero as a known count (C4)', () => {
    expect(knownCount(0)).toEqual({ ok: true, value: { kind: 'known', value: 0 } });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(knownCount(value).ok).toBe(false);
  });

  it('distinguishes unavailable from zero (G5)', () => {
    expect(UNAVAILABLE).toEqual({ kind: 'unavailable' });
    expect(UNAVAILABLE).not.toEqual({ kind: 'known', value: 0 });
  });
});

describe('open-string dimensions (V3)', () => {
  it.each(['cowork_v2', 'claude-future-model-1', 'claude_code', 'chat'])(
    'accepts %s as a product, model and workload',
    (name) => {
      expect(parseProductName(name).ok).toBe(true);
      expect(parseModelName(name).ok).toBe(true);
      expect(parseWorkloadName(name).ok).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['whitespace-padded', ' chat '],
    ['leading whitespace', ' chat'],
    ['trailing whitespace', 'chat '],
  ])('rejects a product that is %s', (_label, raw) => {
    expect(parseProductName(raw).ok).toBe(false);
    expect(parseModelName(raw).ok).toBe(false);
  });

  it.each(['a'.repeat(65), 'chat/../x', '-chat', 'my product'])(
    'accepts open product and model value %s',
    (raw) => {
      expect(parseProductName(raw).ok).toBe(true);
      expect(parseModelName(raw).ok).toBe(true);
    },
  );

  it('keeps the strict format for workload names', () => {
    expect(parseWorkloadName('a'.repeat(65)).ok).toBe(false);
    expect(parseWorkloadName('chat/../x').ok).toBe(false);
  });
});
