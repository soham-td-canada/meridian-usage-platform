import { parseEnvironment, type Environment } from '../../config/src/index.js';
import {
  parseGroupId,
  parseUserId,
  fail,
  ok,
  type Brand,
  type Capability,
  type Directory,
  type GroupId,
  type Result,
  type UserId,
  type UserRole,
} from '../../domain/src/index.js';
import { denial, type Denial } from './denial.js';
import { mayTargetAnyGroup, roleHasScope, type Scope } from './policy.js';

// Branded so an actor can only come from resolveActor, never from a request-shaped object.
export type TrustedActor = Brand<
  { readonly userId: UserId; readonly role: UserRole; readonly homeGroup: GroupId },
  'TrustedActor'
>;

export interface CapabilityStateEntry {
  readonly groupId: GroupId;
  readonly capability: Capability;
  readonly enabled: boolean;
}

export type CapabilityStateSnapshot =
  | { readonly kind: 'available'; readonly entries: readonly CapabilityStateEntry[] }
  | { readonly kind: 'unavailable' };

export type AuthorizationDecision =
  | { readonly kind: 'allow'; readonly group: GroupId }
  | { readonly kind: 'deny'; readonly denial: Denial };

const allow = (group: GroupId): AuthorizationDecision => ({ kind: 'allow', group });
const deny = (reason: Denial): AuthorizationDecision => ({ kind: 'deny', denial: reason });

/** Resolves the actor from the trusted directory; role and group never come from the request. */
export function resolveActor(
  directory: Directory,
  trustedUserId: string,
): Result<TrustedActor, Denial> {
  const userId = parseUserId(trustedUserId);
  const user = userId.ok ? directory.usersById.get(userId.value) : undefined;
  const [homeGroup, ...extraGroups] = user?.groupIds ?? [];
  if (user === undefined || homeGroup === undefined || extraGroups.length > 0) {
    return fail(denial('identity_unresolved'));
  }
  return ok({ userId: user.userId, role: user.role, homeGroup } as TrustedActor);
}

function resolveTargetGroup(
  environment: Environment,
  scope: Scope,
  actor: TrustedActor,
  directory: Directory,
  requestedGroup: unknown,
): Result<GroupId, Denial> {
  let target: GroupId;
  if (requestedGroup === undefined) {
    target = actor.homeGroup;
  } else {
    const parsed = typeof requestedGroup === 'string' ? parseGroupId(requestedGroup) : undefined;
    const known = parsed?.ok === true && directory.groupsById.has(parsed.value);
    if (parsed === undefined || !parsed.ok || !known) {
      // Callers who cannot see every group get the same denial as for a foreign group.
      return fail(
        denial(
          mayTargetAnyGroup(environment, actor.role, scope)
            ? 'group_not_found'
            : 'group_not_permitted',
        ),
      );
    }
    target = parsed.value;
  }
  if (target !== actor.homeGroup && !mayTargetAnyGroup(environment, actor.role, scope)) {
    return fail(denial('group_not_permitted'));
  }
  return ok(target);
}

function checkUsageConnector(
  actor: TrustedActor,
  state: CapabilityStateSnapshot,
): Denial | undefined {
  if (state.kind === 'unavailable') {
    return denial('capability_state_unavailable');
  }
  const rows = state.entries.filter(
    (entry) => entry.groupId === actor.homeGroup && entry.capability === 'usage-connector',
  );
  if (rows.length === 0) {
    return denial('capability_state_unavailable');
  }
  return rows.every((row) => row.enabled) ? undefined : denial('capability_disabled');
}

function authorizeScoped(
  scope: Scope,
  environmentRaw: string,
  actor: TrustedActor,
  directory: Directory,
  requestedGroup: unknown,
): { readonly result: Result<GroupId, Denial> } | Denial {
  const environment = parseEnvironment(environmentRaw);
  if (!environment.ok) {
    return denial('policy_unavailable');
  }
  if (!roleHasScope(environment.value, actor.role, scope)) {
    return denial('scope_not_granted', scope);
  }
  return {
    result: resolveTargetGroup(environment.value, scope, actor, directory, requestedGroup),
  };
}

/** Authorizes usage_summary, top_users and capability_status (scope usage:read). */
export function authorizeRead(input: {
  readonly environment: string;
  readonly actor: TrustedActor;
  readonly requestedGroup: unknown;
  readonly directory: Directory;
  readonly capabilityState: CapabilityStateSnapshot;
}): AuthorizationDecision {
  const scoped = authorizeScoped(
    'usage:read',
    input.environment,
    input.actor,
    input.directory,
    input.requestedGroup,
  );
  if ('error' in scoped) {
    return deny(scoped);
  }
  if (!scoped.result.ok) {
    return deny(scoped.result.error);
  }
  const gate = checkUsageConnector(input.actor, input.capabilityState);
  return gate === undefined ? allow(scoped.result.value) : deny(gate);
}

/** Authorizes set_capability (scope capabilities:write); deliberately not gated by usage-connector. */
export function authorizeCapabilityWrite(input: {
  readonly environment: string;
  readonly actor: TrustedActor;
  readonly requestedGroup: unknown;
  readonly directory: Directory;
}): AuthorizationDecision {
  const scoped = authorizeScoped(
    'capabilities:write',
    input.environment,
    input.actor,
    input.directory,
    // set_capability requires an explicit group; an omitted one is malformed, never defaulted.
    input.requestedGroup ?? null,
  );
  if ('error' in scoped) {
    return deny(scoped);
  }
  if (!scoped.result.ok) {
    return deny(scoped.result.error);
  }
  return allow(scoped.result.value);
}
