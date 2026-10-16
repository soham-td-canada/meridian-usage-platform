import { createRequire } from 'node:module';

/*
 * drizzle-orm's published .d.ts files do not pass this repository's strict library checks, and
 * tsconfig must not be weakened. Drizzle is therefore loaded at runtime behind the narrow,
 * locally declared surface below. Everything read back through it is `unknown` and must be
 * validated by the caller. Only the operations Step 4 needs are declared.
 */

declare const opaque: unique symbol;

export interface Column {
  readonly [opaque]: 'column';
}
export interface Condition {
  readonly [opaque]: 'condition';
}
export interface Ordering {
  readonly [opaque]: 'ordering';
}

export interface ColumnBuilder {
  notNull(): ColumnBuilder;
  primaryKey(): ColumnBuilder;
}

export interface RunResult {
  readonly changes: number;
}

export interface InsertQuery {
  values(row: Readonly<Record<string, unknown>>): {
    onConflictDoNothing(): { run(): RunResult };
  };
}

export interface UpdateQuery {
  set(values: Readonly<Record<string, unknown>>): {
    where(condition: Condition): { run(): RunResult };
  };
}

export interface SelectQuery {
  where(condition: Condition): SelectQuery;
  orderBy(...orderings: readonly Ordering[]): SelectQuery;
  all(): readonly unknown[];
  get(): unknown;
}

export interface Table {
  readonly [opaque]: 'table';
}

export interface OrmDatabase {
  insert(table: Table): InsertQuery;
  update(table: Table): UpdateQuery;
  select(fields?: Readonly<Record<string, Column>>): { from(table: Table): SelectQuery };
}

export interface DrizzleRuntime {
  readonly drizzle: (sqlite: object) => OrmDatabase;
  readonly defineTable: (
    name: string,
    columns: Readonly<Record<string, ColumnBuilder>>,
    primaryKeyColumns?: readonly string[],
  ) => Table;
  readonly text: (name: string) => ColumnBuilder;
  readonly integer: (name: string, mode?: 'number' | 'boolean') => ColumnBuilder;
  readonly eq: (column: Column, value: unknown) => Condition;
  readonly ne: (column: Column, value: unknown) => Condition;
  readonly and: (...conditions: readonly Condition[]) => Condition;
  readonly isNull: (column: Column) => Condition;
  readonly asc: (column: Column) => Ordering;
}

const nodeRequire = createRequire(import.meta.url);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

type Untyped = (...args: unknown[]) => unknown;

function member(moduleName: string, name: string): Untyped {
  const loaded: unknown = nodeRequire(moduleName);
  if (!isRecord(loaded)) {
    throw new TypeError(`${moduleName} did not load as a module`);
  }
  const value = loaded[name];
  if (typeof value !== 'function') {
    throw new TypeError(`${moduleName}.${name} is not a function`);
  }
  return value as Untyped;
}

function loadRuntime(): DrizzleRuntime {
  const sqliteCore = 'drizzle-orm/sqlite-core';
  const root = 'drizzle-orm';
  const sqliteTable = member(sqliteCore, 'sqliteTable');
  const primaryKey = member(sqliteCore, 'primaryKey');
  const text = member(sqliteCore, 'text');
  const integer = member(sqliteCore, 'integer');
  const drizzle = member('drizzle-orm/better-sqlite3', 'drizzle');
  const eq = member(root, 'eq');
  const ne = member(root, 'ne');
  const and = member(root, 'and');
  const isNull = member(root, 'isNull');
  const asc = member(root, 'asc');

  return {
    drizzle: (sqlite) => drizzle(sqlite) as OrmDatabase,
    defineTable: (name, columns, primaryKeyColumns) =>
      sqliteTable(
        name,
        columns,
        primaryKeyColumns === undefined
          ? undefined
          : (table: Readonly<Record<string, unknown>>) => ({
              pk: primaryKey({ columns: primaryKeyColumns.map((column) => table[column]) }),
            }),
      ) as Table,
    text: (name) => text(name) as ColumnBuilder,
    integer: (name, mode) =>
      (mode === undefined ? integer(name) : integer(name, { mode })) as ColumnBuilder,
    eq: (column, value) => eq(column, value) as Condition,
    ne: (column, value) => ne(column, value) as Condition,
    and: (...conditions) => and(...conditions) as Condition,
    isNull: (column) => isNull(column) as Condition,
    asc: (column) => asc(column) as Ordering,
  };
}

export const drizzleRuntime: DrizzleRuntime = loadRuntime();
