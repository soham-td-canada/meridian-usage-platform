import { CAPABILITY_DEFAULTS, parseEnvironment, type Environment } from '@meridian/config';
import {
  CAPABILITIES,
  parseCapability,
  parseGroupId,
  type Capability,
  type DirectoryGroup,
  type GroupId,
  type Result,
} from '@meridian/domain';
import type { PersistenceDatabase } from './db.js';
import type { PersistenceError } from './errors.js';
import { drizzleRuntime as d } from './drizzle-runtime.js';
import { capabilityState, groups } from './schema.js';

interface CapabilityStateRowRecord {
  readonly groupId: string;
  readonly capability: string;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface CapabilityStateRow {
  readonly groupId: GroupId;
  readonly capability: Capability;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface CapabilityInitializationResult {
  readonly createdRows: number;
  readonly totalRows: number;
}

export interface CapabilitySetResult {
  readonly changed: boolean;
  readonly row: CapabilityStateRow;
}

function fail<T>(error: PersistenceError): Result<T, PersistenceError> {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T, PersistenceError> {
  return { ok: true, value };
}

function isCapabilityStateRecord(value: unknown): value is CapabilityStateRowRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Readonly<Record<string, unknown>>;
  return (
    typeof row['groupId'] === 'string' &&
    typeof row['capability'] === 'string' &&
    typeof row['enabled'] === 'boolean' &&
    (row['updatedAt'] === null || typeof row['updatedAt'] === 'string') &&
    (row['updatedBy'] === null || typeof row['updatedBy'] === 'string')
  );
}

function parseCapabilityStateRow(raw: unknown): Result<CapabilityStateRow, PersistenceError> {
  if (!isCapabilityStateRecord(raw)) {
    return fail({ kind: 'integrity_error', message: 'malformed capability_state row' });
  }
  const row = raw;
  const groupId = parseGroupId(row.groupId);
  if (!groupId.ok) {
    return fail({ kind: 'integrity_error', message: groupId.error });
  }
  const capability = parseCapability(row.capability);
  if (!capability.ok) {
    return fail({ kind: 'integrity_error', message: capability.error });
  }
  return ok({
    groupId: groupId.value,
    capability: capability.value,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  });
}

function knownGroups(groupsInDirectory: readonly DirectoryGroup[]): ReadonlySet<string> {
  return new Set(groupsInDirectory.map((group) => group.groupId));
}

function enabledByDefault(
  environment: Environment,
  capability: Capability,
  groupId: GroupId,
): boolean {
  const definition = CAPABILITY_DEFAULTS[environment][capability];
  switch (definition.kind) {
    case 'all':
      return definition.enabled;
    case 'groups':
      return definition.enabledGroupIds.some((candidate) => candidate === groupId);
  }
}

function validateDefaults(
  environment: Environment,
  groupsInDirectory: readonly DirectoryGroup[],
): Result<void, PersistenceError> {
  const defaults = CAPABILITY_DEFAULTS[environment];
  const availableGroups = knownGroups(groupsInDirectory);
  for (const capability of CAPABILITIES) {
    const definition = defaults[capability];
    if (definition.kind === 'groups') {
      for (const groupId of definition.enabledGroupIds) {
        if (!availableGroups.has(groupId)) {
          return fail({ kind: 'config_group_missing', environment, groupId });
        }
      }
    }
  }
  return ok(undefined);
}

function missingMatrixRows(
  database: PersistenceDatabase,
  groupsInDirectory: readonly DirectoryGroup[],
): readonly string[] {
  const present = new Set<string>();
  for (const row of database.orm
    .select({ groupId: capabilityState.groupId, capability: capabilityState.capability })
    .from(capabilityState)
    .all()) {
    if (typeof row === 'object' && row !== null && 'groupId' in row && 'capability' in row) {
      present.add(`${String(row.groupId)}/${String(row.capability)}`);
    }
  }
  const missing: string[] = [];
  for (const group of groupsInDirectory) {
    for (const capability of CAPABILITIES) {
      const id = `${group.groupId}/${capability}`;
      if (!present.has(id)) {
        missing.push(id);
      }
    }
  }
  return missing;
}

export function initializeCapabilityState(
  database: PersistenceDatabase,
  environmentRaw: string,
  groupsInDirectory: readonly DirectoryGroup[],
): Result<CapabilityInitializationResult, PersistenceError> {
  const environment = parseEnvironment(environmentRaw);
  if (!environment.ok) {
    return fail({ kind: 'unknown_environment', environment: environmentRaw });
  }
  const defaultsValid = validateDefaults(environment.value, groupsInDirectory);
  if (!defaultsValid.ok) {
    return defaultsValid;
  }
  let createdRows = 0;
  for (const group of groupsInDirectory) {
    for (const capability of CAPABILITIES) {
      createdRows += database.orm
        .insert(capabilityState)
        .values({
          groupId: group.groupId,
          capability,
          enabled: enabledByDefault(environment.value, capability, group.groupId),
          updatedAt: null,
          updatedBy: null,
        })
        .onConflictDoNothing()
        .run().changes;
    }
  }
  // The matrix is checked per current group x capability so stale groups cannot mask gaps.
  const missing = missingMatrixRows(database, groupsInDirectory);
  if (missing.length > 0) {
    return fail({
      kind: 'integrity_error',
      message: `missing capability-state rows after initialization: ${missing.join(', ')}`,
    });
  }
  return ok({ createdRows, totalRows: groupsInDirectory.length * CAPABILITIES.length });
}

export function listCapabilityState(
  database: PersistenceDatabase,
): Result<readonly CapabilityStateRow[], PersistenceError> {
  const rows = database.orm
    .select()
    .from(capabilityState)
    .orderBy(d.asc(capabilityState.groupId), d.asc(capabilityState.capability))
    .all();
  const parsed: CapabilityStateRow[] = [];
  for (const row of rows) {
    const value = parseCapabilityStateRow(row);
    if (!value.ok) {
      return value;
    }
    parsed.push(value.value);
  }
  return ok(parsed);
}

function groupExists(database: PersistenceDatabase, groupId: string): boolean {
  return (
    database.orm
      .select({ groupId: groups.groupId })
      .from(groups)
      .where(d.eq(groups.groupId, groupId))
      .get() !== undefined
  );
}

function readCapabilityRow(
  database: PersistenceDatabase,
  groupId: GroupId,
  capability: Capability,
): unknown {
  return database.orm
    .select()
    .from(capabilityState)
    .where(
      d.and(d.eq(capabilityState.groupId, groupId), d.eq(capabilityState.capability, capability)),
    )
    .get();
}

export function setCapabilityState(
  database: PersistenceDatabase,
  input: {
    readonly groupId: string;
    readonly capability: string;
    readonly enabled: boolean;
    readonly updatedAt: string;
    readonly updatedBy: string;
  },
): Result<CapabilitySetResult, PersistenceError> {
  const groupId = parseGroupId(input.groupId);
  if (!groupId.ok) {
    return fail({ kind: 'unknown_group', groupId: input.groupId });
  }
  const capability = parseCapability(input.capability);
  if (!capability.ok) {
    return fail({ kind: 'unknown_capability', capability: input.capability });
  }
  if (!groupExists(database, groupId.value)) {
    return fail({ kind: 'unknown_group', groupId: input.groupId });
  }
  if (readCapabilityRow(database, groupId.value, capability.value) === undefined) {
    return fail({ kind: 'state_missing', groupId: groupId.value, capability: capability.value });
  }
  // The comparison lives in the WHERE clause: a same-value set matches no row and writes nothing.
  const { changes } = database.orm
    .update(capabilityState)
    .set({ enabled: input.enabled, updatedAt: input.updatedAt, updatedBy: input.updatedBy })
    .where(
      d.and(
        d.eq(capabilityState.groupId, groupId.value),
        d.eq(capabilityState.capability, capability.value),
        d.ne(capabilityState.enabled, input.enabled),
      ),
    )
    .run();
  const current = readCapabilityRow(database, groupId.value, capability.value);
  if (current === undefined) {
    return fail({ kind: 'state_missing', groupId: groupId.value, capability: capability.value });
  }
  const parsed = parseCapabilityStateRow(current);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({ changed: changes > 0, row: parsed.value });
}
