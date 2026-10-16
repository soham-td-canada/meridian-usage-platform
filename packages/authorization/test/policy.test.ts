import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, type Environment } from '../../config/src/index.js';
import {
  buildDirectory,
  CAPABILITIES,
  type Directory,
  type GroupId,
  type UserRole,
} from '../../domain/src/index.js';
import {
  initializeCapabilityState,
  listCapabilityState,
  setCapabilityState,
} from '../../persistence/src/index.js';
import {
  fixtureDirectory,
  openMemoryDatabase,
  seedGroups,
} from '../../persistence/test/helpers.js';
import {
  authorizeCapabilityWrite,
  authorizeRead,
  resolveActor,
  roleHasScope,
  type AuthorizationDecision,
  type CapabilityStateSnapshot,
  type DenialCode,
  type TrustedActor,
} from '../src/index.js';

const fixture = fixtureDirectory();
const directoryResult = buildDirectory(fixture.users, fixture.groups);
if (!directoryResult.ok) {
  throw new Error(directoryResult.error);
}
const directory: Directory = directoryResult.value;

function actorWhere(role: UserRole, groupId: string): TrustedActor {
  const user = fixture.users.find((u) => u.role === role && u.groupIds.some((g) => g === groupId));
  if (user === undefined) {
    throw new Error(`no ${role} in ${groupId}`);
  }
  const resolved = resolveActor(directory, user.userId);
  if (!resolved.ok) {
    throw new Error('actor unresolved');
  }
  return resolved.value;
}

const ACTORS: Readonly<Record<UserRole, TrustedActor>> = {
  member: actorWhere('member', 'clinical-operations'),
  team_lead: actorWhere('team_lead', 'finance'),
  platform_admin: actorWhere('platform_admin', 'it-platform'),
};
const OTHER: Readonly<Record<UserRole, string>> = {
  member: 'regulatory-affairs',
  team_lead: 'hr',
  platform_admin: 'hr',
};

function snapshot(
  enabled: (group: GroupId, capability: string) => boolean,
): CapabilityStateSnapshot {
  return {
    kind: 'available',
    entries: fixture.groups.flatMap((group) =>
      CAPABILITIES.map((capability) => ({
        groupId: group.groupId,
        capability,
        enabled: enabled(group.groupId, capability),
      })),
    ),
  };
}
const ALL_ENABLED = snapshot(() => true);

function read(
  environment: string,
  actor: TrustedActor,
  requestedGroup: unknown,
  capabilityState: CapabilityStateSnapshot = ALL_ENABLED,
): AuthorizationDecision {
  return authorizeRead({ environment, actor, requestedGroup, directory, capabilityState });
}

function write(environment: string, actor: TrustedActor, requestedGroup: unknown) {
  return authorizeCapabilityWrite({ environment, actor, requestedGroup, directory });
}

function outcome(decision: AuthorizationDecision): string {
  return decision.kind === 'allow' ? 'allow' : decision.denial.code;
}

type Expected = readonly [own: string, other: string, unknown: string, omitted: string];
const ALLOW = 'allow';
const NO_SCOPE: Expected = [
  'scope_not_granted',
  'scope_not_granted',
  'scope_not_granted',
  'scope_not_granted',
];
const LEAD_SCOPED: Expected = [ALLOW, 'group_not_permitted', 'group_not_permitted', ALLOW];
const ADMIN_READ: Expected = [ALLOW, ALLOW, 'group_not_found', ALLOW];
const LEAD_WRITE: Expected = [
  ALLOW,
  'group_not_permitted',
  'group_not_permitted',
  'group_not_permitted',
];
const ADMIN_WRITE: Expected = [ALLOW, ALLOW, 'group_not_found', 'group_not_found'];

const READ_MATRIX: readonly (readonly [Environment, UserRole, Expected])[] = [
  ['dev', 'member', ADMIN_READ],
  ['dev', 'team_lead', ADMIN_READ],
  ['dev', 'platform_admin', ADMIN_READ],
  ['staging', 'member', NO_SCOPE],
  ['staging', 'team_lead', LEAD_SCOPED],
  ['staging', 'platform_admin', ADMIN_READ],
  ['prod', 'member', NO_SCOPE],
  ['prod', 'team_lead', LEAD_SCOPED],
  ['prod', 'platform_admin', ADMIN_READ],
];

const WRITE_MATRIX: readonly (readonly [Environment, UserRole, Expected])[] = [
  ['dev', 'member', NO_SCOPE],
  ['dev', 'team_lead', LEAD_WRITE],
  ['dev', 'platform_admin', ADMIN_WRITE],
  ['staging', 'member', NO_SCOPE],
  ['staging', 'team_lead', LEAD_WRITE],
  ['staging', 'platform_admin', ADMIN_WRITE],
  ['prod', 'member', NO_SCOPE],
  ['prod', 'team_lead', NO_SCOPE],
  ['prod', 'platform_admin', ADMIN_WRITE],
];

function targets(role: UserRole): readonly unknown[] {
  const actor = ACTORS[role];
  return [actor.homeGroup, OTHER[role], 'no-such-group', undefined];
}

describe('authorization matrix', () => {
  it.each(READ_MATRIX)('read %s %s', (environment, role, expected) => {
    const actual = targets(role).map((target) => outcome(read(environment, ACTORS[role], target)));
    expect(actual).toEqual(expected);
  });

  it.each(WRITE_MATRIX)('write %s %s', (environment, role, expected) => {
    const actual = targets(role).map((target) => outcome(write(environment, ACTORS[role], target)));
    expect(actual).toEqual(expected);
  });

  it('allow decisions resolve the default group to the home group and the explicit group otherwise', () => {
    const admin = ACTORS.platform_admin;
    expect(read('prod', admin, undefined)).toEqual({ kind: 'allow', group: admin.homeGroup });
    expect(read('prod', admin, 'hr')).toEqual({ kind: 'allow', group: 'hr' });
    expect(write('prod', admin, 'hr')).toEqual({ kind: 'allow', group: 'hr' });
  });

  it('scope grants match starter-kit/environments YAML', () => {
    for (const environment of ENVIRONMENTS) {
      const text = readFileSync(
        join(process.cwd(), `starter-kit/environments/${environment}.yaml`),
        'utf8',
      );
      const rolesFor = (scope: string): string[] => {
        const after = text.split(`${scope}:`)[1] ?? '';
        const line = after.split('\n').find((l) => l.trim().startsWith('roles:')) ?? '';
        return (line.split('[')[1]?.split(']')[0] ?? '').split(',').map((r) => r.trim());
      };
      for (const role of ['member', 'team_lead', 'platform_admin'] as const) {
        expect(roleHasScope(environment, role, 'usage:read')).toBe(
          rolesFor('usage:read').includes(role),
        );
        expect(roleHasScope(environment, role, 'capabilities:write')).toBe(
          rolesFor('capabilities:write').includes(role),
        );
      }
    }
  });

  it('scope denials name the required scope and nothing else is attached', () => {
    const denied = read('prod', ACTORS.member, undefined);
    expect(denied).toMatchObject({
      kind: 'deny',
      denial: { code: 'scope_not_granted', required_scope: 'usage:read' },
    });
    const writeDenied = write('prod', ACTORS.team_lead, ACTORS.team_lead.homeGroup);
    expect(writeDenied).toMatchObject({ denial: { required_scope: 'capabilities:write' } });
    const groupDenied = read('prod', ACTORS.team_lead, 'hr');
    expect(groupDenied.kind === 'deny' && 'required_scope' in groupDenied.denial).toBe(false);
  });
});

describe('usage-connector capability gate', () => {
  const disabledFor = (target: string): CapabilityStateSnapshot =>
    snapshot((group, capability) => !(group === target && capability === 'usage-connector'));

  it('denies reads when the home group has usage-connector disabled', () => {
    for (const role of ['team_lead', 'platform_admin'] as const) {
      const state = disabledFor(ACTORS[role].homeGroup);
      expect(outcome(read('prod', ACTORS[role], undefined, state))).toBe('capability_disabled');
    }
  });

  it('only the usage-connector row of the home group matters', () => {
    const lead = ACTORS.team_lead;
    const other = snapshot(
      (group, capability) => !(group === lead.homeGroup && capability !== 'usage-connector'),
    );
    expect(outcome(read('prod', lead, undefined, other))).toBe('allow');
    expect(outcome(read('prod', lead, undefined, disabledFor('hr')))).toBe('allow');
  });

  it('does not gate a platform admin reading a disabled foreign group', () => {
    expect(outcome(read('prod', ACTORS.platform_admin, 'hr', disabledFor('hr')))).toBe('allow');
  });

  it('denies when the row is missing, the snapshot is unavailable or duplicates conflict', () => {
    const lead = ACTORS.team_lead;
    const withoutRow: CapabilityStateSnapshot = {
      kind: 'available',
      entries:
        ALL_ENABLED.kind === 'available'
          ? ALL_ENABLED.entries.filter(
              (e) => !(e.groupId === lead.homeGroup && e.capability === 'usage-connector'),
            )
          : [],
    };
    expect(outcome(read('prod', lead, undefined, withoutRow))).toBe('capability_state_unavailable');
    expect(outcome(read('prod', lead, undefined, { kind: 'unavailable' }))).toBe(
      'capability_state_unavailable',
    );
    expect(outcome(read('prod', lead, undefined, { kind: 'available', entries: [] }))).toBe(
      'capability_state_unavailable',
    );
    const conflicting: CapabilityStateSnapshot = {
      kind: 'available',
      entries: [
        { groupId: lead.homeGroup, capability: 'usage-connector', enabled: true },
        { groupId: lead.homeGroup, capability: 'usage-connector', enabled: false },
      ],
    };
    expect(outcome(read('prod', lead, undefined, conflicting))).toBe('capability_disabled');
  });

  it('does not gate set_capability, so a disabled connector can be re-enabled', () => {
    expect(outcome(write('prod', ACTORS.platform_admin, ACTORS.platform_admin.homeGroup))).toBe(
      'allow',
    );
  });

  it('scope and group denials take precedence over missing state and leak nothing about it', () => {
    expect(outcome(read('prod', ACTORS.member, undefined, { kind: 'unavailable' }))).toBe(
      'scope_not_granted',
    );
    expect(outcome(read('prod', ACTORS.team_lead, 'hr', { kind: 'unavailable' }))).toBe(
      'group_not_permitted',
    );
  });
});

describe('fail-closed and adversarial behavior', () => {
  it('denies an unknown environment for every role', () => {
    for (const role of ['member', 'team_lead', 'platform_admin'] as const) {
      for (const environment of ['', 'production', 'PROD', 'prod ']) {
        expect(outcome(read(environment, ACTORS[role], undefined))).toBe('policy_unavailable');
        expect(outcome(write(environment, ACTORS[role], ACTORS[role].homeGroup))).toBe(
          'policy_unavailable',
        );
      }
    }
  });

  it('rejects unknown users and users without exactly one group', () => {
    for (const id of ['nobody', '', ' ', 'USER_X']) {
      const resolved = resolveActor(directory, id);
      expect(resolved.ok ? 'ok' : resolved.error.code).toBe('identity_unresolved');
    }
    const base = fixture.users[0];
    if (base === undefined) {
      throw new Error('empty fixture');
    }
    const groups = fixture.groups.slice(0, 2);
    const groupIds = groups.map((g) => g.groupId);
    const lead = fixture.users.find((u) => groups.some((g) => g.teamLeadUserId === u.userId));
    if (lead === undefined) {
      throw new Error('no lead');
    }
    const others = fixture.users.filter((u) => u.userId !== lead.userId);
    for (const ids of [[], groupIds]) {
      const built = buildDirectory([...others, { ...lead, groupIds: ids }], fixture.groups);
      if (!built.ok) {
        throw new Error(built.error);
      }
      const resolved = resolveActor(built.value, lead.userId);
      expect(resolved.ok ? 'ok' : resolved.error.code).toBe('identity_unresolved');
    }
  });

  it('treats malformed, case-varied and non-string group requests as unauthorized', () => {
    const lead = ACTORS.team_lead;
    const own = lead.homeGroup;
    const attempts: readonly unknown[] = [
      own.toUpperCase(),
      ` ${own}`,
      `${own} `,
      '',
      null,
      42,
      { toString: () => own },
      [own],
      `${own}\u0000`,
    ];
    for (const attempt of attempts) {
      expect(outcome(read('prod', lead, attempt))).toBe('group_not_permitted');
      expect(outcome(write('staging', lead, attempt))).toBe('group_not_permitted');
    }
    for (const attempt of attempts) {
      expect(outcome(read('prod', ACTORS.platform_admin, attempt))).toBe('group_not_found');
    }
  });

  it('does not accept a hand-built actor (type-level)', () => {
    const forged = { userId: 'x', role: 'platform_admin', homeGroup: 'hr' };
    // @ts-expect-error actors must come from resolveActor
    const decision = read('prod', forged, 'hr');
    expect(decision.kind).toBeDefined();
  });

  it('ignores client-supplied role, scope, group and identity fields', () => {
    const forged = {
      role: 'platform_admin',
      scopes: ['capabilities:write'],
      userId: 'x',
      group: 'hr',
    };
    const member = ACTORS.member;
    expect(outcome(read('prod', member, forged))).toBe('scope_not_granted');
    expect(outcome(write('dev', member, forged))).toBe('scope_not_granted');
    const lead = ACTORS.team_lead;
    expect(outcome(write('prod', lead, forged))).toBe('scope_not_granted');
    expect(outcome(read('prod', lead, forged))).toBe('group_not_permitted');
    const resolved = resolveActor(directory, lead.userId);
    expect(resolved.ok && resolved.value.role).toBe('team_lead');
  });

  it('denials are fixed, leak neither requested groups nor user data, and are identical for unknown and foreign groups', () => {
    const lead = ACTORS.team_lead;
    const foreign = read('prod', lead, 'hr');
    const unknown = read('prod', lead, 'secret-unknown-group');
    expect(foreign).toEqual(unknown);
    const serialized = JSON.stringify([foreign, unknown, read('prod', ACTORS.member, 'hr')]);
    for (const secret of [
      'hr"',
      'secret-unknown-group',
      lead.userId,
      ...fixture.users.map((u) => u.email),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(foreign).toEqual({
      kind: 'deny',
      denial: expect.objectContaining({ error: 'permission_denied' }) as unknown,
    });
    expect(Object.keys(foreign.kind === 'deny' ? foreign.denial : {}).sort()).toEqual([
      'code',
      'error',
      'reason',
    ]);
  });

  it('denies every code only through the permission_denied shape', () => {
    const codes = new Set<DenialCode>();
    const sample = [
      read('x', ACTORS.member, undefined),
      read('prod', ACTORS.member, undefined),
      read('prod', ACTORS.team_lead, 'hr'),
      read('prod', ACTORS.platform_admin, 'zz'),
      read('prod', ACTORS.team_lead, undefined, { kind: 'unavailable' }),
      read(
        'prod',
        ACTORS.team_lead,
        undefined,
        snapshot(() => false),
      ),
    ];
    for (const decision of sample) {
      if (decision.kind === 'deny') {
        expect(decision.denial.error).toBe('permission_denied');
        codes.add(decision.denial.code);
      }
    }
    expect([...codes].sort()).toEqual([
      'capability_disabled',
      'capability_state_unavailable',
      'group_not_found',
      'group_not_permitted',
      'policy_unavailable',
      'scope_not_granted',
    ]);
  });
});

describe('real Step 4 capability state', () => {
  it('prod defaults: usage-connector only for it-platform and clinical-operations; admin toggles are honored', () => {
    const opened = openMemoryDatabase();
    try {
      seedGroups(opened.database, fixture.groups);
      expect(initializeCapabilityState(opened.database, 'prod', fixture.groups).ok).toBe(true);
      const state = (): CapabilityStateSnapshot => {
        const rows = listCapabilityState(opened.database);
        return rows.ok ? { kind: 'available', entries: rows.value } : { kind: 'unavailable' };
      };
      const lead = (group: string): TrustedActor => actorWhere('team_lead', group);
      expect(outcome(read('prod', lead('clinical-operations'), undefined, state()))).toBe('allow');
      expect(outcome(read('prod', lead('finance'), undefined, state()))).toBe(
        'capability_disabled',
      );
      expect(
        setCapabilityState(opened.database, {
          groupId: 'finance',
          capability: 'usage-connector',
          enabled: true,
          updatedAt: '2026-10-18T00:00:00.000Z',
          updatedBy: ACTORS.platform_admin.userId,
        }).ok,
      ).toBe(true);
      expect(outcome(read('prod', lead('finance'), undefined, state()))).toBe('allow');
      expect(outcome(read('prod', lead('finance'), undefined, { kind: 'unavailable' }))).toBe(
        'capability_state_unavailable',
      );
    } finally {
      opened.cleanup();
    }
  });
});
