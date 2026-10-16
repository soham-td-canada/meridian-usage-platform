import type { Count, UnavailableCount } from './count.js';
import type { Money } from './money.js';
import type { ModelName, ProductName, WorkloadName } from './dimensions.js';
import type { GroupId, UserId } from './identity.js';
import type { UtcDay } from './time.js';

export type Dimension =
  | { readonly kind: 'product'; readonly name: ProductName }
  | { readonly kind: 'workload'; readonly name: WorkloadName };

export type TokenDirection = 'input' | 'output';

interface ObservationBase {
  readonly userId: UserId;
  readonly groupId: GroupId;
  readonly period: UtcDay;
  readonly model: ModelName;
}

export interface ClaudeUsageObservation extends ObservationBase {
  readonly platform: 'claude';
  readonly kind: 'usage';
  readonly dimension: Extract<Dimension, { kind: 'product' }>;
  readonly uncachedInput: number;
  readonly cacheReadInput: number;
  readonly cacheCreation5mInput: number;
  readonly cacheCreation1hInput: number;
  readonly output: number;
  readonly inputTotal: number;
  readonly requests: Count;
  readonly webSearchRequests: Count;
}

export interface GeminiUsageObservation extends ObservationBase {
  readonly platform: 'gemini';
  readonly kind: 'usage';
  readonly dimension: Extract<Dimension, { kind: 'workload' }>;
  readonly direction: TokenDirection;
  readonly tokens: Count;
  readonly requests: UnavailableCount;
  readonly cache: UnavailableCount;
  readonly webSearch: UnavailableCount;
}

export type UsageObservation = ClaudeUsageObservation | GeminiUsageObservation;

export interface ClaudeChargeObservation extends ObservationBase {
  readonly platform: 'claude';
  readonly kind: 'charge';
  readonly dimension: Extract<Dimension, { kind: 'product' }>;
  readonly chargeKind: 'tokens' | 'web_search';
  readonly amount: Money;
}

export interface GeminiChargeObservation extends ObservationBase {
  readonly platform: 'gemini';
  readonly kind: 'charge';
  readonly dimension: Extract<Dimension, { kind: 'workload' }>;
  readonly direction: TokenDirection;
  readonly amount: Money;
}

export type ChargeObservation = ClaudeChargeObservation | GeminiChargeObservation;
