import type { UnresolvedReason } from './attribution.js';

export type SourceName = 'claude_usage' | 'claude_cost' | 'gemini_billing';

export interface SourceRef {
  readonly source: SourceName;
  /** Zero-based index into the source's data array (or JSONL line). */
  readonly rowIndex: number;
}

/**
 * Exactly one outcome per source row. Only `resolved` carries a canonical value.
 */
export type Outcome<T> =
  | { readonly kind: 'resolved'; readonly value: T }
  | { readonly kind: 'unresolved'; readonly source: SourceRef; readonly reason: UnresolvedReason }
  | {
      readonly kind: 'rejected';
      readonly source: SourceRef;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly source: SourceRef;
      readonly code: string;
      readonly message: string;
    };
