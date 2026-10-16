import type { Scope } from './policy.js';

export const DENIAL_CODES = [
  'identity_unresolved',
  'policy_unavailable',
  'scope_not_granted',
  'group_not_permitted',
  'group_not_found',
  'capability_disabled',
  'capability_state_unavailable',
] as const;

export type DenialCode = (typeof DENIAL_CODES)[number];

/** Matches the starter-kit `Denial` shape; `code` is an additive machine-readable field. */
export interface Denial {
  readonly error: 'permission_denied';
  readonly code: DenialCode;
  readonly reason: string;
  readonly required_scope?: Scope;
}

// Fixed strings only: a reason must never echo requested groups, names or usage data.
const REASONS: Readonly<Record<DenialCode, string>> = {
  identity_unresolved: 'The caller identity could not be resolved.',
  policy_unavailable: 'The authorization policy is unavailable.',
  scope_not_granted: 'The caller lacks the required scope.',
  group_not_permitted: 'The caller may not access the requested group.',
  group_not_found: 'The requested group does not exist.',
  capability_disabled: 'The usage connector is disabled for the caller group.',
  capability_state_unavailable: 'The capability state is unavailable.',
};

export function denial(code: DenialCode, requiredScope?: Scope): Denial {
  const base = { error: 'permission_denied', code, reason: REASONS[code] } as const;
  return requiredScope === undefined ? base : { ...base, required_scope: requiredScope };
}
