import { readFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { drizzleRuntime, type OrmDatabase } from './drizzle-runtime.js';

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export interface PersistenceDatabase {
  readonly sqlite: SqliteDatabase;
  readonly orm: OrmDatabase;
  readonly filePath: string;
  close(): void;
}

const MIGRATIONS = [new URL('./migrations/0001_initial.sql', import.meta.url)] as const;

function isFileBacked(path: string): boolean {
  return path !== ':memory:';
}

export function openPersistenceDatabase(filePath: string): PersistenceDatabase {
  const sqlite = new BetterSqlite3(filePath);
  sqlite.defaultSafeIntegers(true);
  sqlite.pragma('foreign_keys = ON');
  if (isFileBacked(filePath)) {
    sqlite.pragma('journal_mode = WAL');
  }
  return {
    sqlite,
    orm: drizzleRuntime.drizzle(sqlite),
    filePath,
    close: () => sqlite.close(),
  };
}

/** Idempotent DDL. Transactional in SQLite, so callers may run it inside their own transaction. */
export function applyMigrations(database: PersistenceDatabase): void {
  for (const url of MIGRATIONS) {
    database.sqlite.exec(readFileSync(url, 'utf8'));
  }
}

export function foreignKeysEnabled(database: PersistenceDatabase): boolean {
  const row = database.sqlite.pragma('foreign_keys', { simple: true });
  return row === 1 || row === 1n;
}
