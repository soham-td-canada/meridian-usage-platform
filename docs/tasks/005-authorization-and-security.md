# 005 — Authorization and Security Policy

## Goal

A centralized, pure, server-side policy engine (`packages/authorization`) deciding whether a trusted actor may perform one of the four tool operations. No transport (MCP/API/UI), no persistence access, no business logic.

Sources: `starter-kit/README.md`, `starter-kit/environments/*.yaml`, `starter-kit/contracts/tools.schema.json` (read-only), Task 004 (missing capability state is denied, never enabled).

## Affected invariants

- Identity and role come only from the trusted directory, resolved from a server-supplied user id. Requests never carry role, scope or identity.
- Unknown/missing/ambiguous state denies. Denials carry no protected data.
- Authorization is independent of Fastify/React/Drizzle/MCP. Step 2–4 code is not modified.

## Actors, roles, scopes

- Actor: `TrustedActor { userId, role, homeGroup }`, produced only by `resolveActor(directory, trustedUserId)`. The role is read from the directory user; the home group is the user's only `groupIds` entry. Unknown user, or a user with zero or several groups, is `identity_unresolved`.
- Roles: `member`, `team_lead`, `platform_admin`. Scopes: `usage:read`, `capabilities:write`.
- Tool → scope: `usage_summary`, `top_users`, `capability_status` → `usage:read`; `set_capability` → `capabilities:write`.

## Authorization matrix

Scope grants (from the environment YAML):

| env     | `usage:read`                      | `capabilities:write`      |
| ------- | --------------------------------- | ------------------------- |
| dev     | member, team_lead, platform_admin | team_lead, platform_admin |
| staging | team_lead, platform_admin         | team_lead, platform_admin |
| prod    | team_lead, platform_admin         | platform_admin            |

Group rule for an allowed scope:

| operation          | member (dev)   | team_lead                                       | platform_admin |
| ------------------ | -------------- | ----------------------------------------------- | -------------- |
| read, dev          | any group      | any group                                       | any group      |
| read, staging/prod | n/a (no scope) | own group only                                  | any group      |
| write, all envs    | n/a (no scope) | own group only (least privilege, see Decisions) | any group      |

## Default group

`group` omitted → the actor's home group (admins included). Home group is the only default; there is no fallback to "all groups".

## Cross-group rules

- A requested group is parsed as a `GroupId` and must exist in the directory.
- For non-admins that cannot see the requested group, an unknown group and a foreign group produce the identical `group_not_permitted` denial (no existence oracle). Only a `platform_admin` or a dev reader may receive `group_not_found`.
- Denial text never echoes the requested group, user names or any usage data.

## Capability-state interaction

- `usage-connector` gates `usage:read` operations. The actor's **home group** must have `usage-connector` enabled; otherwise deny with `capability_disabled`.
- The requested/target group is not capability-gated, so an authorized platform admin can read another group's data even if that group's connector is disabled.
- `set_capability` is intentionally exempt from the `usage-connector` gate. It is a control-plane operation and must remain available to an otherwise-authorized actor so a disabled connector can be re-enabled.
- This exemption does not bypass authorization: `set_capability` still requires the required role, `capabilities:write` scope, and permitted target group.
- Capability state is supplied as a snapshot: `{ kind: 'available', entries } | { kind: 'unavailable' }`.
- An unavailable snapshot or a missing `(homeGroup, usage-connector)` row fails closed with `capability_state_unavailable`.
- Persisted `enabled` state is the only source of truth. The authorization engine does not read environment defaults and does not mutate capability state.


## Denial shape and codes

Maps to the contract `Denial`: `{ error: 'permission_denied', code, reason, required_scope? }` (`code` is an additive field; `reason` is a fixed string per code).

Codes: `identity_unresolved`, `policy_unavailable` (unknown environment), `scope_not_granted` (includes `required_scope`), `group_not_permitted`, `group_not_found`, `capability_disabled`, `capability_state_unavailable`.

## Check order and fail-closed behavior

1. environment parses → else `policy_unavailable`
2. role has the scope in this environment → else `scope_not_granted`
3. resolve/validate group (default, parse, existence, visibility) → `group_not_permitted` / `group_not_found`
4. (read only) `usage-connector` gate → `capability_disabled` / `capability_state_unavailable`

Any unrecognized role, scope, environment or condition denies. Switches are exhaustive. A deny decision contains only the `Denial`.

## Function signatures

```ts
resolveActor(directory: Directory, trustedUserId: string): Result<TrustedActor, Denial>;

authorizeRead(input: {
  environment: string;
  actor: TrustedActor;
  requestedGroup: unknown; // external data; non-string/non-GroupId is treated as malformed
  directory: Directory;
  capabilityState: CapabilityStateSnapshot;
}): AuthorizationDecision;

authorizeCapabilityWrite(input: {
  environment: string;
  actor: TrustedActor;
  requestedGroup: unknown;
  directory: Directory;
}): AuthorizationDecision;

type AuthorizationDecision =
  | { kind: 'allow'; group: GroupId }
  | { kind: 'deny'; denial: Denial };
```

`capability` validity for `set_capability` is not an authorization concern (Task 004 `setCapabilityState` rejects unknown values).

## Decisions on unspecified points

- Team lead write scope is limited to their own group in every environment (the YAML grants only the scope; least privilege applies).
- "Their group" in the contract denial rule is the caller's home group.
- Persistence imports are test-only; the engine consumes a plain snapshot. Cross-package source imports are relative (Step 4 precedent) so no `package.json`/lockfile changes are needed.
- `set_capability` exemption from the usage-connector gate deviates from the contract text "every tool"; flagged for human review.

## MUST-HAVE tests (table-driven, `packages/authorization/test`)

1. Full matrix: env × role × operation × target (own / other / unknown / omitted) against the real fixture directory.
2. Scope grants cross-checked against `starter-kit/environments/*.yaml`.
3. Default group for every role; admin default is own group.
4. Non-admin unknown vs foreign group denials are identical (no enumeration); denials contain no requested group or usage data.
5. Capability gate: disabled home group denies read; enabled allows; admin reading a disabled foreign group allowed; missing row and `unavailable` snapshot deny; `set_capability` not gated.
6. Fail-closed: unknown environment, unknown user, multi-group/zero-group user, malformed group id.
7. Adversarial: client-supplied role/scope/user fields are ignored; role escalation via requested group, case/whitespace variants of group ids.
8. Real Step 4 state: capability rows from `initializeCapabilityState`/`setCapabilityState`/`listCapabilityState` drive prod gate decisions.

## Out of scope

MCP/API/UI transport, authentication/session handling, tool input schema validation, usage queries, audit logging, rate limiting, persistence changes, defaults changes, Step 6.
