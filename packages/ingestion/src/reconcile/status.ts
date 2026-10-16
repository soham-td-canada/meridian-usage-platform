import type { CheckResult } from './types.js';

export type RunStatus = 'blocked' | 'partial' | 'complete_with_exclusions' | 'complete' | 'failed';

export interface StatusInput {
  readonly directoryFailed: boolean;
  readonly sourceFailures: number;
  readonly exclusions: number;
  readonly checks: readonly CheckResult[];
}

/**
 * Exactly one status. A failed integrity check is never hidden by partial/complete statuses;
 * a directory failure blocks everything.
 */
export function computeRunStatus(input: StatusInput): RunStatus {
  if (input.directoryFailed) {
    return 'blocked';
  }
  if (input.checks.some((check) => check.status === 'fail')) {
    return 'failed';
  }
  if (input.sourceFailures > 0) {
    return 'partial';
  }
  return input.exclusions > 0 ? 'complete_with_exclusions' : 'complete';
}
