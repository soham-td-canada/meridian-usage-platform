export type CheckStatus = 'pass' | 'fail' | 'not_run';

/** One bucket/measure comparison: raw = canonical + excluded + unexplained. */
export interface DeltaLine {
  readonly selector: string;
  readonly bucket: string;
  readonly measure: string;
  /** Sum over every raw row whose measure was measurable. */
  readonly raw: bigint;
  readonly canonical: bigint;
  /** Measurable raw value belonging to rows that were not accepted. */
  readonly excluded: bigint;
  readonly unexplained: bigint;
  /** True when any contributing raw measure could not be parsed. Exact reconciliation is impossible. */
  readonly unmeasurable: boolean;
}

export interface Issue {
  readonly code: string;
  readonly subject: string;
}

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly deltas: readonly DeltaLine[];
  readonly issues: readonly Issue[];
}

export interface GapReport {
  readonly platform: string;
  /** `not_run` when a source the platform depends on failed or was not supplied. */
  readonly status: 'evaluated' | 'not_run';
  readonly sourceDays: number;
  readonly missingDays: readonly string[];
}
