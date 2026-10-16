import {
  initializeCapabilityState,
  applyMigrations,
  openPersistenceDatabase,
  type PersistenceDatabase,
} from '../../../packages/persistence/src/index.js';
import type { Directory, DirectoryUser } from '../../../packages/domain/src/index.js';
import {
  STARTER_KIT_DIR,
  createToolService,
  loadTrustedDirectory,
  provisionDatabase,
  type JsonValue,
  type ToolOutcome,
  type ToolService,
} from '../src/index.js';

export const FIXED_NOW = new Date('2026-10-01T12:00:00.000Z');

export interface Harness {
  readonly database: PersistenceDatabase;
  readonly directory: Directory;
  readonly service: ToolService;
}

export function loadDirectoryOrThrow(): Directory {
  const loaded = loadTrustedDirectory(STARTER_KIT_DIR);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  return loaded.value;
}

export function harness(environment: string, now: () => Date = () => FIXED_NOW): Harness {
  const directory = loadDirectoryOrThrow();
  const provisioned = provisionDatabase({
    environment: 'dev',
    databasePath: ':memory:',
    starterKitDir: STARTER_KIT_DIR,
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  if (!provisioned.ok) {
    throw new Error(provisioned.error);
  }
  return withEnvironment(provisioned.value.database, directory, environment, now);
}

/** Provisioned for a specific environment's capability defaults. */
export function provisionedHarness(
  environment: 'dev' | 'staging' | 'prod',
  now: () => Date = () => FIXED_NOW,
): Harness {
  const directory = loadDirectoryOrThrow();
  const provisioned = provisionDatabase({
    environment,
    databasePath: ':memory:',
    starterKitDir: STARTER_KIT_DIR,
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  if (!provisioned.ok) {
    throw new Error(provisioned.error);
  }
  return withEnvironment(provisioned.value.database, directory, environment, now);
}

export function withEnvironment(
  database: PersistenceDatabase,
  directory: Directory,
  environment: string,
  now: () => Date = () => FIXED_NOW,
): Harness {
  return {
    database,
    directory,
    service: createToolService({ environment, directory, database, now }),
  };
}

/** Migrated database with capability rows but no ingested usage. */
export function emptyUsageHarness(environment: 'dev' | 'prod'): Harness {
  const directory = loadDirectoryOrThrow();
  const database = openPersistenceDatabase(':memory:');
  applyMigrations(database);
  const insert = database.sqlite.prepare('INSERT INTO groups (group_id, name) VALUES (?, ?)');
  for (const group of directory.groupsById.values()) {
    insert.run(group.groupId, group.name);
  }
  const seeded = initializeCapabilityState(database, environment, [
    ...directory.groupsById.values(),
  ]);
  if (!seeded.ok) {
    throw new Error('seed failed');
  }
  return withEnvironment(database, directory, environment);
}

export function userWith(
  directory: Directory,
  role: string,
  groupId: string,
  index = 0,
): DirectoryUser {
  const matches = [...directory.usersById.values()].filter(
    (user) => user.role === role && user.groupIds.some((group) => group === groupId),
  );
  const user = matches[index];
  if (user === undefined) {
    throw new Error(`no ${role} in ${groupId}`);
  }
  return user;
}

export function okValue(outcome: ToolOutcome): JsonValue {
  if (outcome.kind !== 'ok') {
    throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

export function usd(units: bigint): number {
  const digits = units.toString().padStart(9, '0');
  return Number(`${digits.slice(0, -8)}.${digits.slice(-8)}`);
}
