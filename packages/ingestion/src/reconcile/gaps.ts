import { dateRange } from '../raw/calendar.js';
import { compareStrings } from '../ingest/identity.js';
import type { GapReport } from './types.js';

export interface DateWindow {
  readonly start: string;
  readonly end: string;
}

/**
 * Platform x day gap detection. A gap is a date inside the window with no accepted rows for the platform.
 * An expected window should be supplied; the observed minimum..maximum default cannot see leading or trailing gaps. Gaps are warnings; nothing is synthesized.
 */
export function detectGaps(
  platform: string,
  days: readonly string[],
  window?: DateWindow,
): GapReport {
  const observed = [...new Set(days)].sort(compareStrings);
  const first = observed[0];
  const last = observed[observed.length - 1];
  const start = window?.start ?? first;
  const end = window?.end ?? last;
  if (start === undefined || end === undefined) {
    return { platform, status: 'evaluated', sourceDays: 0, missingDays: [] };
  }
  const present = new Set(observed);
  return {
    platform,
    status: 'evaluated',
    sourceDays: observed.length,
    missingDays: dateRange(start, end).filter((day) => !present.has(day)),
  };
}
