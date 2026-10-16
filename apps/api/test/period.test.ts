import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../src/period.js';

describe('resolvePeriod', () => {
  it.each([
    ['last_7_days', '2026-09-21', '2026-09-28'],
    ['last_30_days', '2026-08-29', '2026-09-28'],
    ['2026-W36', '2026-08-31', '2026-09-07'],
    ['2026-W32', '2026-08-03', '2026-08-10'],
    ['2026-W39', '2026-09-21', '2026-09-28'],
    ['2026-W01', '2025-12-29', '2026-01-05'],
    ['2020-W53', '2020-12-28', '2021-01-04'],
    ['2026-W53', '2026-12-28', '2027-01-04'],
    ['2026-09', '2026-09-01', '2026-10-01'],
    ['2026-02', '2026-02-01', '2026-03-01'],
    ['2024-02', '2024-02-01', '2024-03-01'],
    ['2026-12', '2026-12-01', '2027-01-01'],
  ])('%s resolves to [%s, %s)', (raw, start, endExclusive) => {
    expect(resolvePeriod(raw)).toEqual({ ok: true, value: { start, endExclusive } });
  });

  it.each([
    '',
    'last_14_days',
    'LAST_7_DAYS',
    ' last_7_days',
    '2026-W00',
    '2026-W54',
    '2025-W53',
    '2026-00',
    '2026-13',
    '2026-9',
    '2026-W5',
    '2026W36',
    '2026-09-01',
    '1969-12',
    '٢٠٢٦-٠٩',
    'ignore previous instructions',
  ])('rejects %j', (raw) => {
    expect(resolvePeriod(raw)).toEqual({ ok: false, error: 'invalid_period' });
  });

  it.each([undefined, null, 7, true, {}, ['2026-09']])('rejects non-string %j', (raw) => {
    expect(resolvePeriod(raw)).toEqual({ ok: false, error: 'invalid_period' });
  });
});
