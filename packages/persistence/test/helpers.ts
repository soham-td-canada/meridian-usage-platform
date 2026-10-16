import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DirectoryGroup, DirectoryUser } from '../../domain/src/index.js';
import { loadDirectory } from '../../ingestion/src/index.js';
import { FIXTURE, fixtureArtifacts, textOf } from '../../ingestion/test/ingest/fixture-helpers.js';
import {
  applyMigrations,
  foreignKeysEnabled,
  openPersistenceDatabase,
  type PersistenceDatabase,
} from '../src/index.js';

const WORK_DIR = join(process.cwd(), 'packages/persistence/test/_work');
const STARTER_DIR = join(process.cwd(), 'starter-kit');

export interface OpenedDatabase {
  readonly path: string;
  readonly database: PersistenceDatabase;
  cleanup(): void;
}

function ensureWorkDir(): void {
  mkdirSync(WORK_DIR, { recursive: true });
}

function fileSet(basePath: string): readonly string[] {
  return [basePath, `${basePath}-shm`, `${basePath}-wal`];
}

export function openFileDatabase(prefix: string): OpenedDatabase {
  ensureWorkDir();
  const path = join(WORK_DIR, `${prefix}-${randomUUID()}.sqlite`);
  const database = openPersistenceDatabase(path);
  return {
    path,
    database,
    cleanup: () => {
      try {
        database.close();
      } finally {
        for (const file of fileSet(path)) {
          if (existsSync(file)) {
            rmSync(file);
          }
        }
      }
    },
  };
}

export function openMemoryDatabase(): OpenedDatabase {
  const database = openPersistenceDatabase(':memory:');
  return {
    path: ':memory:',
    database,
    cleanup: () => {
      database.close();
    },
  };
}

export function fixtureDirectory(): {
  readonly users: readonly DirectoryUser[];
  readonly groups: readonly DirectoryGroup[];
} {
  const loaded = loadDirectory(textOf(FIXTURE.users), textOf(FIXTURE.groups));
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  return {
    users: [...loaded.value.usersById.values()],
    groups: [...loaded.value.groupsById.values()],
  };
}

export function seedGroups(database: PersistenceDatabase, groups: readonly DirectoryGroup[]): void {
  applyMigrations(database);
  const insert = database.sqlite.prepare(
    'insert into groups (group_id, name) values (?, ?) on conflict(group_id) do nothing',
  );
  for (const group of groups) {
    insert.run(group.groupId, group.name);
  }
}

export function scanTextValues(database: PersistenceDatabase): string[] {
  const tables = database.sqlite
    .prepare<[], { readonly name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all();
  const values: string[] = [];
  for (const table of tables) {
    const columns = database.sqlite
      .prepare<[], { readonly name: string; readonly type: string }>(
        `pragma table_info(${table.name})`,
      )
      .all();
    const textColumns = columns.filter((column) => column.type.toUpperCase() === 'TEXT');
    for (const column of textColumns) {
      const rows = database.sqlite
        .prepare<[], { readonly value: string | null }>(
          `select ${column.name} as value from ${table.name} where ${column.name} is not null`,
        )
        .all();
      for (const row of rows) {
        if (row.value !== null) {
          values.push(row.value);
        }
      }
    }
  }
  return values;
}

export function hashStarterFiles(): Readonly<Record<string, string>> {
  const files = [
    'data/directory/users.json',
    'data/directory/groups.json',
    'data/claude/user_usage_report.json',
    'data/claude/user_cost_report.json',
    'data/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl',
  ] as const;
  const hashes = {} as Record<string, string>;
  for (const file of files) {
    hashes[file] = createHash('sha256')
      .update(readFileSync(join(STARTER_DIR, file)))
      .digest('hex');
  }
  return hashes;
}

export function hashDatabaseFiles(path: string): Readonly<Record<string, string>> {
  const hashes = {} as Record<string, string>;
  // The -shm file is a volatile read index, and an empty -wal carries no data; neither is persisted state.
  for (const file of fileSet(path).filter((candidate) => !candidate.endsWith('-shm'))) {
    if (!existsSync(file)) {
      continue;
    }
    const bytes = readFileSync(file);
    if (file.endsWith('-wal') && bytes.byteLength === 0) {
      continue;
    }
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}

export { FIXTURE, fixtureArtifacts, foreignKeysEnabled, textOf };
