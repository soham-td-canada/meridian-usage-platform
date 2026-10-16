import { drizzleRuntime as d, type Column, type Table } from './drizzle-runtime.js';

/*
 * Drizzle covers non-money persistence. Observation tables (money and token counts) are written
 * and read with raw better-sqlite3 statements and safe-integer handling so bigint stays exact.
 * The SQL migration is the schema source of truth; these definitions must mirror it.
 */
export interface SourceArtifactsTable extends Table {
  readonly source: Column;
  readonly sha256: Column;
  readonly byteLength: Column;
}

export interface DirectorySnapshotsTable extends Table {
  readonly sha256: Column;
  readonly firstSeenRunId: Column;
}

export interface UsersTable extends Table {
  readonly userId: Column;
  readonly name: Column;
}

export interface GroupsTable extends Table {
  readonly groupId: Column;
  readonly name: Column;
}

export interface CapabilityStateTable extends Table {
  readonly groupId: Column;
  readonly capability: Column;
  readonly enabled: Column;
  readonly updatedAt: Column;
  readonly updatedBy: Column;
}

function isTableWith<T extends Table>(table: Table, keys: readonly (keyof T)[]): table is T {
  return keys.every((key) => key in table);
}

function defineChecked<T extends Table>(table: Table, keys: readonly (keyof T & string)[]): T {
  if (!isTableWith<T>(table, keys)) {
    throw new TypeError('drizzle table is missing expected columns');
  }
  return table;
}

export const sourceArtifacts = defineChecked<SourceArtifactsTable>(
  d.defineTable(
    'source_artifacts',
    {
      source: d.text('source').notNull(),
      sha256: d.text('sha256').notNull(),
      byteLength: d.integer('byte_length', 'number').notNull(),
    },
    ['source', 'sha256'],
  ),
  ['source', 'sha256', 'byteLength'],
);

export const directorySnapshots = defineChecked<DirectorySnapshotsTable>(
  d.defineTable('directory_snapshots', {
    sha256: d.text('sha256').primaryKey(),
    firstSeenRunId: d.integer('first_seen_run_id', 'number'),
  }),
  ['sha256', 'firstSeenRunId'],
);

export const users = defineChecked<UsersTable>(
  d.defineTable('users', {
    userId: d.text('user_id').primaryKey(),
    name: d.text('name').notNull(),
  }),
  ['userId', 'name'],
);

export const groups = defineChecked<GroupsTable>(
  d.defineTable('groups', {
    groupId: d.text('group_id').primaryKey(),
    name: d.text('name').notNull(),
  }),
  ['groupId', 'name'],
);

export const capabilityState = defineChecked<CapabilityStateTable>(
  d.defineTable(
    'capability_state',
    {
      groupId: d.text('group_id').notNull(),
      capability: d.text('capability').notNull(),
      enabled: d.integer('enabled', 'boolean').notNull(),
      updatedAt: d.text('updated_at'),
      updatedBy: d.text('updated_by'),
    },
    ['groupId', 'capability'],
  ),
  ['groupId', 'capability', 'enabled', 'updatedAt', 'updatedBy'],
);
