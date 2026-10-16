import {
  fail,
  isoWeekOf,
  ok,
  parseUtcDay,
  utcDayContaining,
  type Result,
  type UtcDay,
} from '../../../packages/domain/src/index.js';

/** Relative periods anchor to the end of the supplied data window (starter-kit README). */
export const DATA_WINDOW_END_EXCLUSIVE = '2026-09-28';

const DAY_MS = 86_400_000;
const MIN_YEAR = 1970;
const WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** A `[start, endExclusive)` range of UTC days. */
export interface ResolvedPeriod {
  readonly start: UtcDay;
  readonly endExclusive: UtcDay;
}

function range(startMs: number, endMs: number): Result<ResolvedPeriod, 'invalid_period'> {
  return ok({ start: utcDayContaining(startMs), endExclusive: utcDayContaining(endMs) });
}

function anchorMs(): number {
  const anchor = parseUtcDay(DATA_WINDOW_END_EXCLUSIVE);
  if (!anchor.ok) {
    throw new RangeError('invalid data window anchor');
  }
  return Date.parse(`${anchor.value}T00:00:00.000Z`);
}

function isoWeekRange(year: number, week: number): Result<ResolvedPeriod, 'invalid_period'> {
  const jan4 = Date.UTC(year, 0, 4);
  const weekdayOfJan4 = (new Date(jan4).getUTCDay() + 6) % 7;
  const startMs = jan4 - weekdayOfJan4 * DAY_MS + (week - 1) * 7 * DAY_MS;
  const expected = `${String(year)}-W${String(week).padStart(2, '0')}`;
  // Week 53 only exists in some years: reject weeks that roll into the next ISO year.
  if (isoWeekOf(utcDayContaining(startMs)) !== expected) {
    return fail('invalid_period');
  }
  return range(startMs, startMs + 7 * DAY_MS);
}

/** Resolves an external `period` value. Anything outside the contract grammar is invalid. */
export function resolvePeriod(raw: unknown): Result<ResolvedPeriod, 'invalid_period'> {
  if (typeof raw !== 'string') {
    return fail('invalid_period');
  }
  switch (raw) {
    case 'last_7_days':
      return range(anchorMs() - 7 * DAY_MS, anchorMs());
    case 'last_30_days':
      return range(anchorMs() - 30 * DAY_MS, anchorMs());
  }
  const week = WEEK_PATTERN.exec(raw);
  if (week !== null) {
    const year = Number.parseInt(week[1] ?? '', 10);
    const number = Number.parseInt(week[2] ?? '', 10);
    return year < MIN_YEAR || number < 1 ? fail('invalid_period') : isoWeekRange(year, number);
  }
  const month = MONTH_PATTERN.exec(raw);
  if (month !== null) {
    const year = Number.parseInt(month[1] ?? '', 10);
    const number = Number.parseInt(month[2] ?? '', 10);
    if (year < MIN_YEAR || number < 1 || number > 12) {
      return fail('invalid_period');
    }
    return range(Date.UTC(year, number - 1, 1), Date.UTC(year, number, 1));
  }
  return fail('invalid_period');
}
