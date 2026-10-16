import { utcDayFromBounds, type UtcDay } from '@meridian/domain';
import { orReject, reject } from './validate.js';

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const GEMINI_UTC = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/;

interface CalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/** Parses an RFC 3339 UTC timestamp (Claude) into epoch milliseconds. */
export function parseRfc3339Utc(text: string, label: string): number {
  const match = RFC3339_UTC.exec(text);
  if (match === null) {
    reject('time', `${label} must be an RFC 3339 UTC timestamp`);
  }
  const fraction = match[7] ?? '';
  return epochMsOf(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
      millisecond: Number(fraction.slice(0, 3).padEnd(3, '0')),
    },
    label,
  );
}

/** Parses a Gemini `YYYY-MM-DD HH:MM:SS UTC` timestamp into epoch milliseconds. */
export function parseGeminiUtc(text: string, label: string): number {
  const match = GEMINI_UTC.exec(text);
  if (match === null) {
    reject('time', `${label} must be a 'YYYY-MM-DD HH:MM:SS UTC' timestamp`);
  }
  return epochMsOf(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
      millisecond: 0,
    },
    label,
  );
}

/**
 * Converts calendar fields to epoch milliseconds. Values that Date.parse would silently
 * normalize (e.g. 2026-02-30, 24:00:00, second 60) are rejected instead.
 */
function epochMsOf(fields: CalendarFields, label: string): number {
  if (fields.month < 1 || fields.month > 12) {
    reject('time', `${label} has an invalid month`);
  }
  if (fields.day < 1 || fields.day > daysInMonth(fields.year, fields.month)) {
    reject('time', `${label} has an invalid day for its month`);
  }
  if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    reject('time', `${label} has an invalid time of day`);
  }
  const date = new Date(0);
  date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  date.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  return date.getTime();
}

/** `month` is 1-based; day 0 of the following month index is the last day of `month`. */
function daysInMonth(year: number, month: number): number {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

/** A usage period is valid only if it is a valid 24-hour UTC `[start, end)` interval. */
export function usageDay(startMs: number, endMs: number): UtcDay {
  return orReject(utcDayFromBounds(startMs, endMs), 'time');
}
