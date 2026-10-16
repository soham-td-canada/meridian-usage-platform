import type { Brand } from './brand.js';
import { fail, ok, type Result } from './result.js';

/** UTC day key `YYYY-MM-DD`, the calendar date of a 24-hour `[start, end)` source interval. */
export type UtcDay = Brand<string, 'UtcDay'>;

/** Monday-based ISO week in UTC, formatted as `YYYY-Www`. */
export type IsoWeek = Brand<string, 'IsoWeek'>;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function dayFromEpochMs(epochMs: number): UtcDay {
  return new Date(epochMs).toISOString().slice(0, 10) as UtcDay;
}

/**
 * Builds a day key from a source interval `[startMs, endMs)`. The interval must be exactly
 * 24h long; the key is the UTC calendar date of its start. Callers derive bounds from usage
 * timestamps only.
 */
export function utcDayFromBounds(startMs: number, endMs: number): Result<UtcDay, string> {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    return fail('UtcDay bounds must be integer epoch milliseconds');
  }
  if (endMs - startMs !== DAY_MS) {
    return fail('UtcDay must end exactly 24 hours after it starts');
  }
  return ok(dayFromEpochMs(startMs));
}

export function utcDayContaining(epochMs: number): UtcDay {
  if (!Number.isSafeInteger(epochMs)) {
    throw new RangeError('epochMs must be an integer');
  }
  return dayFromEpochMs(Math.floor(epochMs / DAY_MS) * DAY_MS);
}

export function isoWeekOf(day: UtcDay): IsoWeek {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  // Monday = 0 ... Sunday = 6.
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  // The ISO week belongs to the year that contains its Thursday.
  const thursday = midnight + (3 - weekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / WEEK_MS) + 1;
  return `${String(isoYear)}-W${String(week).padStart(2, '0')}` as IsoWeek;
}
