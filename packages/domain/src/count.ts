import { fail, ok, type Result } from './result.js';

/** A known non-negative integer, or unavailable. Missing is never represented as zero. */
export interface UnavailableCount {
  readonly kind: 'unavailable';
}

export type Count = { readonly kind: 'known'; readonly value: number } | UnavailableCount;

export const UNAVAILABLE: UnavailableCount = { kind: 'unavailable' };

export function knownCount(value: number): Result<Count, string> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail('Count must be a non-negative safe integer');
  }
  return ok({ kind: 'known', value });
}
