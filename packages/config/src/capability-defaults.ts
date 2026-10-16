import { type Capability, parseGroupId, type GroupId } from '@meridian/domain';
import type { Environment } from './environment.js';

interface EnabledForAllDefault {
  readonly kind: 'all';
  readonly enabled: boolean;
}

interface EnabledForGroupsDefault {
  readonly kind: 'groups';
  readonly enabledGroupIds: readonly GroupId[];
}

export type CapabilityDefault = EnabledForAllDefault | EnabledForGroupsDefault;

export type CapabilityDefaults = Readonly<Record<Capability, CapabilityDefault>>;

function trustedGroupId(raw: string): GroupId {
  const parsed = parseGroupId(raw);
  if (!parsed.ok) {
    throw new RangeError(parsed.error);
  }
  return parsed.value;
}

export const CAPABILITY_DEFAULTS: Readonly<Record<Environment, CapabilityDefaults>> = {
  dev: {
    'usage-connector': { kind: 'all', enabled: true },
    'web-search': { kind: 'all', enabled: true },
    'code-execution': { kind: 'all', enabled: true },
  },
  staging: {
    'usage-connector': { kind: 'all', enabled: true },
    'web-search': { kind: 'all', enabled: true },
    'code-execution': { kind: 'all', enabled: false },
  },
  prod: {
    'usage-connector': {
      kind: 'groups',
      enabledGroupIds: [trustedGroupId('it-platform'), trustedGroupId('clinical-operations')],
    },
    'web-search': { kind: 'all', enabled: true },
    'code-execution': { kind: 'all', enabled: false },
  },
};

export function defaultCapabilityEnabledForGroup(
  environment: Environment,
  capability: Capability,
  groupId: GroupId,
): boolean {
  const value = CAPABILITY_DEFAULTS[environment][capability];
  switch (value.kind) {
    case 'all':
      return value.enabled;
    case 'groups':
      return value.enabledGroupIds.some((candidate) => candidate === groupId);
  }
}
