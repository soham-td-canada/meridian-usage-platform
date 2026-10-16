import type { Environment } from '../../config/src/index.js';
import type { UserRole } from '../../domain/src/index.js';

export type Scope = 'usage:read' | 'capabilities:write';

// Mirrors starter-kit/environments/*.yaml; cross-checked by tests.
const SCOPE_ROLES: Readonly<Record<Environment, Readonly<Record<Scope, readonly UserRole[]>>>> = {
  dev: {
    'usage:read': ['member', 'team_lead', 'platform_admin'],
    'capabilities:write': ['team_lead', 'platform_admin'],
  },
  staging: {
    'usage:read': ['team_lead', 'platform_admin'],
    'capabilities:write': ['team_lead', 'platform_admin'],
  },
  prod: {
    'usage:read': ['team_lead', 'platform_admin'],
    'capabilities:write': ['platform_admin'],
  },
};

const READ_ANY_GROUP: Readonly<Record<Environment, boolean>> = {
  dev: true,
  staging: false,
  prod: false,
};

export function roleHasScope(environment: Environment, role: UserRole, scope: Scope): boolean {
  return SCOPE_ROLES[environment][scope].some((candidate) => candidate === role);
}

/** True when the role may target any group (existing or not) for this scope. */
export function mayTargetAnyGroup(environment: Environment, role: UserRole, scope: Scope): boolean {
  switch (role) {
    case 'platform_admin':
      return true;
    case 'team_lead':
    case 'member':
      return scope === 'usage:read' && READ_ANY_GROUP[environment];
  }
}
