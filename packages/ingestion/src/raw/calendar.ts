const DAY_MS = 86_400_000;

/** Validated calendar date prefix `YYYY-MM-DD` of a timestamp, or undefined. */
export function validDate(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): string | undefined {
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const probe = new Date(0);
  probe.setUTCFullYear(y, m - 1, d);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

/** UTC day of a Claude RFC 3339 timestamp. */
export function claudeDay(text: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.exec(text ?? '');
  return validDate(match?.[1], match?.[2], match?.[3]);
}

/** UTC day of a Gemini `YYYY-MM-DD HH:MM:SS UTC` timestamp. */
export function geminiDay(text: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) \d{2}:\d{2}:\d{2} UTC$/.exec(text ?? '');
  return validDate(match?.[1], match?.[2], match?.[3]);
}

function epochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(0);
  probe.setUTCFullYear(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return Math.round(probe.getTime() / DAY_MS);
}

/** ISO 8601 week (`YYYY-Www`) of a valid `YYYY-MM-DD` date, computed with integer day counts. */
export function rawIsoWeek(date: string): string {
  const days = epochDay(date);
  // 1970-01-01 was a Thursday; Monday = 0.
  const weekday = (((days + 3) % 7) + 7) % 7;
  const thursday = days - weekday + 3;
  const isoYear = new Date(thursday * DAY_MS).getUTCFullYear();
  const jan1 = epochDay(`${String(isoYear).padStart(4, '0')}-01-01`);
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return `${String(isoYear)}-W${String(week).padStart(2, '0')}`;
}

/** Inclusive list of dates from `start` to `end`. Empty when the range is invalid or inverted. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let day = epochDay(start); day <= epochDay(end); day += 1) {
    out.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}
