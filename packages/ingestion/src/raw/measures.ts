export type Platform = 'claude' | 'gemini';

export type Measure =
  { readonly kind: 'measured'; readonly value: bigint } | { readonly kind: 'unmeasurable' };

export const UNMEASURABLE: Measure = { kind: 'unmeasurable' };

export const measured = (value: bigint | undefined): Measure =>
  value === undefined ? UNMEASURABLE : { kind: 'measured', value };

/** Fields from a Claude row used to pair usage rows with cost rows. */
export interface RawClaudePairing {
  readonly pairKey: string | undefined;
  readonly costType: string | undefined;
  readonly requests: string | undefined;
  readonly rbacGroupId: string | undefined;
  readonly email: string | undefined;
  readonly webSearchRequests: bigint | undefined;
}

export const UNATTRIBUTED = 'unattributed';
export const UNDATED = 'undated';

/** Independently parsed control values for one source row. */
export interface RawRow {
  readonly platform: Platform;
  readonly group: string;
  readonly day: string | undefined;
  readonly week: string;
  readonly model: string;
  readonly measures: ReadonlyMap<string, Measure>;
  readonly claudePairing?: RawClaudePairing;
}

export const CLAUDE_USAGE_MEASURES = [
  'uncachedInput',
  'cacheReadInput',
  'cacheCreation5mInput',
  'cacheCreation1hInput',
  'output',
  'inputTotal',
  'totalTokens',
] as const;

export type MeasureClass = 'tokens' | 'counts' | 'money';

export function measureClass(name: string): MeasureClass {
  if (name === 'amount') {
    return 'money';
  }
  return name === 'requests' || name === 'webSearchRequests' ? 'counts' : 'tokens';
}
