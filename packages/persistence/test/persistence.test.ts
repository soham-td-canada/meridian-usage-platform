import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ingest } from '../../ingestion/src/index.js';
import {
  claudeBytes,
  claudeRows,
  first,
  fixtureArtifacts,
  geminiBytes,
  geminiLines,
  pairKeyOf,
  withFields,
} from '../../ingestion/test/ingest/fixture-helpers.js';
import {
  applyMigrations,
  foreignKeysEnabled,
  ingestAndPersist,
  loadPriorState,
  openPersistenceDatabase,
  verifyPersistedState,
} from '../src/index.js';
import {
  FIXTURE,
  fixtureDirectory,
  hashDatabaseFiles,
  hashStarterFiles,
  openFileDatabase,
  openMemoryDatabase,
  scanTextValues,
  textOf,
} from './helpers.js';

const STARTER_HASHES = hashStarterFiles();

function countOf(
  database: ReturnType<typeof openMemoryDatabase>['database'],
  table: string,
): bigint {
  const row = database.sqlite
    .prepare<[], { readonly count: bigint }>(`select count(*) as count from ${table}`)
    .get();
  return row === undefined ? 0n : row.count;
}

function userTables(database: ReturnType<typeof openMemoryDatabase>['database']): string[] {
  return database.sqlite
    .prepare<[], { readonly name: string }>(
      "select name from sqlite_master where name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => row.name);
}

function usageCounts(database: ReturnType<typeof openMemoryDatabase>['database']): {
  readonly active: bigint;
  readonly usage: bigint;
  readonly charge: bigint;
  readonly excluded: bigint;
  readonly capabilities: bigint;
} {
  return {
    active: countOf(database, 'active_source_rows'),
    usage: countOf(database, 'usage_observations'),
    charge: countOf(database, 'charge_observations'),
    excluded: countOf(database, 'run_excluded_rows'),
    capabilities: countOf(database, 'capability_state'),
  };
}

function persistFixture(environment = 'dev') {
  const opened = openFileDatabase(`persist-${environment}`);
  const result = ingestAndPersist({
    database: opened.database,
    artifacts: fixtureArtifacts(),
    environment,
    recordedAt: '2026-10-16T16:01:07.539Z',
  });
  return { opened, result };
}

function failedArtifacts() {
  const usageRows = claudeRows(FIXTURE.claudeUsage);
  const costRows = claudeRows(FIXTURE.claudeCost);
  const key = pairKeyOf(first(usageRows, usageRows.length - 1));
  return fixtureArtifacts({
    claudeCost: claudeBytes(costRows.filter((row) => pairKeyOf(row) !== key)),
  });
}

function partialArtifacts() {
  return fixtureArtifacts().filter((artifact) => artifact.source !== 'gemini_billing');
}

function blockedArtifacts() {
  return fixtureArtifacts().filter((artifact) => artifact.source !== 'directory');
}

function exclusionArtifacts() {
  const lines = geminiLines(FIXTURE.gemini);
  return fixtureArtifacts({
    gemini: geminiBytes([
      first(lines).replace('"cost": 0.107564', '"cost": 0.107565'),
      ...lines.slice(1),
    ]),
  });
}

function prodRollbackArtifacts() {
  const groupsDoc = JSON.parse(textOf(FIXTURE.groups)) as {
    readonly groups: readonly Record<string, unknown>[];
  };
  const usersDoc = JSON.parse(textOf(FIXTURE.users)) as {
    readonly users: readonly Record<string, unknown>[];
  };
  return fixtureArtifacts({
    users: new TextEncoder().encode(
      JSON.stringify({
        users: usersDoc.users.map((user) => ({
          ...user,
          group_ids: Array.isArray(user['group_ids'])
            ? user['group_ids'].map((groupId) => {
                if (typeof groupId !== 'string') {
                  throw new Error('unexpected group_id value');
                }
                return groupId === 'clinical-operations' ? 'clinical-ops-renamed' : groupId;
              })
            : [],
        })),
      }),
    ),
    groups: new TextEncoder().encode(
      JSON.stringify({
        groups: groupsDoc.groups.map((group) =>
          group['group_id'] === 'clinical-operations'
            ? { ...group, group_id: 'clinical-ops-renamed' }
            : group,
        ),
      }),
    ),
  });
}

function moneyOverflowArtifacts() {
  const lines = geminiLines(FIXTURE.gemini);
  return fixtureArtifacts({
    gemini: geminiBytes([
      first(lines).replace('"cost": 0.107564', '"cost": 92233720368.54775808'),
      ...lines.slice(1),
    ]),
  });
}

function directoryChangedArtifacts() {
  const doc = JSON.parse(textOf(FIXTURE.groups)) as {
    readonly groups: readonly Record<string, unknown>[];
  };
  const [a, b] = doc.groups;
  if (a === undefined || b === undefined) {
    throw new Error('need two groups');
  }
  const updated = [...doc.groups];
  const aRbac = a['claude_rbac_group_id'];
  updated[0] = { ...a, claude_rbac_group_id: b['claude_rbac_group_id'] };
  updated[1] = { ...b, claude_rbac_group_id: aRbac };
  return fixtureArtifacts({
    groups: new TextEncoder().encode(JSON.stringify({ groups: updated })),
  });
}

describe('persistence migration and schema', () => {
  it('creates all required tables, is repeat-safe, enables foreign keys, and enforces them', () => {
    const opened = openMemoryDatabase();
    try {
      applyMigrations(opened.database);
      applyMigrations(opened.database);
      const tables = opened.database.sqlite
        .prepare<[], { readonly name: string }>(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        'active_source_rows',
        'capability_state',
        'charge_observations',
        'directory_snapshots',
        'groups',
        'ingestion_runs',
        'run_excluded_rows',
        'source_artifacts',
        'usage_observations',
        'users',
      ]);
      expect(foreignKeysEnabled(opened.database)).toBe(true);
      expect(() =>
        opened.database.sqlite
          .prepare(
            'insert into active_source_rows (key_digest, source, fingerprint, artifact_sha256, directory_sha256, row_index) values (?, ?, ?, ?, ?, ?)',
          )
          .run('digest', 'claude_usage', 'fp', 'missing', 'missing', 0),
      ).toThrow();
    } finally {
      opened.cleanup();
    }
  });

  it('round-trips bigint money values exactly through better-sqlite3', () => {
    const opened = openMemoryDatabase();
    try {
      opened.database.sqlite.exec('create table probe_money (value integer not null)');
      const insert = opened.database.sqlite.prepare('insert into probe_money (value) values (?)');
      const values = [0n, 1n, 9007199254740993n, 9223372036854775807n] as const;
      for (const value of values) {
        insert.run(value);
      }
      const rows = opened.database.sqlite
        .prepare<[], { readonly value: bigint }>('select value from probe_money order by rowid')
        .all();
      expect(rows.map((row) => row.value)).toEqual(values);
    } finally {
      opened.cleanup();
    }
  });
});

describe('ingest and persist', () => {
  it('persists the clean starter fixture, reloads exactly, and replays after reopen', () => {
    const baseline = ingest(fixtureArtifacts());
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('persist failed');
      expect(result.value.status).toBe('complete');
      expect(result.value.persisted.activeRows).toBe(baseline.state.active.size);
      expect(result.value.persisted.excludedRows).toBe(0);
      expect(verifyPersistedState(opened.database, baseline.state).ok).toBe(true);
      const prior = loadPriorState(opened.database);
      expect(prior.ok).toBe(true);
      if (!prior.ok) throw new Error('load prior failed');
      expect([...prior.value.active.entries()]).toEqual([...baseline.state.active.entries()]);
      expect(prior.value.artifacts).toEqual(baseline.state.artifacts);
      const beforeReopenHashes = hashDatabaseFiles(opened.path);
      opened.database.close();
      const reopened = openPersistenceDatabase(opened.path);
      try {
        const reloaded = loadPriorState(reopened);
        expect(reloaded.ok).toBe(true);
        if (!reloaded.ok) throw new Error('reload failed');
        const replay = ingest(fixtureArtifacts(), reloaded.value);
        expect(replay.report.status).toBe('complete');
        expect(replay.report.counts.accepted).toBe(0);
        expect(replay.report.counts.replayed).toBe(baseline.report.counts.accepted);
        expect(replay.report.counts.restatements).toBe(0);
        expect(replay.report.counts.priorKeysAbsent).toBe(0);
        expect(replay.state.active).toEqual(baseline.state.active);
        expect(hashDatabaseFiles(opened.path)[opened.path]).toBe(beforeReopenHashes[opened.path]);
      } finally {
        reopened.close();
      }
    } finally {
      opened.cleanup();
    }
  }, 15_000);

  it('rejects money above signed int64 before any write', () => {
    const opened = openFileDatabase('money-overflow');
    try {
      const result = ingestAndPersist({
        database: opened.database,
        artifacts: moneyOverflowArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-16T16:01:07.539Z',
      });
      expect(result).toEqual({
        ok: false,
        error: { kind: 'money_out_of_range', amount: 9223372036854775808n },
      });
      expect(userTables(opened.database)).toEqual([]);
    } finally {
      opened.cleanup();
    }
  });

  it('persists complete_with_exclusions trusted state without replacing prior active rows', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('baseline failed');
      const prior = loadPriorState(opened.database);
      expect(prior.ok).toBe(true);
      if (!prior.ok) throw new Error('prior failed');
      const excluded = ingestAndPersist({
        database: opened.database,
        artifacts: exclusionArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(excluded.ok).toBe(true);
      if (!excluded.ok) throw new Error('excluded run failed');
      expect(excluded.value.status).toBe('complete_with_exclusions');
      expect(excluded.value.result.report.counts.restatements).toBe(1);
      const after = loadPriorState(opened.database);
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error('after failed');
      expect([...after.value.active.entries()]).toEqual([...prior.value.active.entries()]);
      expect(after.value.artifacts).toHaveLength(prior.value.artifacts.length + 1);
      expect(after.value.artifacts.slice(0, prior.value.artifacts.length)).toEqual(
        prior.value.artifacts,
      );
      expect(countOf(opened.database, 'run_excluded_rows')).toBeGreaterThan(0n);
    } finally {
      opened.cleanup();
    }
  });

  it('refuses partial, failed, and blocked with zero DB changes, and a subsequent clean run succeeds', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('baseline failed');
      const beforeCounts = usageCounts(opened.database);
      const beforeHashes = hashDatabaseFiles(opened.path);
      const cases = [
        { status: 'partial', artifacts: partialArtifacts() },
        { status: 'failed', artifacts: failedArtifacts() },
        { status: 'blocked', artifacts: blockedArtifacts() },
      ] as const;
      for (const entry of cases) {
        const refused = ingestAndPersist({
          database: opened.database,
          artifacts: entry.artifacts,
          environment: 'dev',
          recordedAt: '2026-10-18T00:00:00.000Z',
        });
        expect(refused).toEqual({
          ok: false,
          error: { kind: 'status_refused', status: entry.status },
        });
        expect(usageCounts(opened.database)).toEqual(beforeCounts);
        expect(hashDatabaseFiles(opened.path)).toEqual(beforeHashes);
      }
      const clean = ingestAndPersist({
        database: opened.database,
        artifacts: fixtureArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-18T12:00:00.000Z',
      });
      expect(clean.ok).toBe(true);
      if (!clean.ok) throw new Error('clean rerun failed');
      expect(clean.value.status).toBe('complete');
      expect(clean.value.result.report.counts.accepted).toBe(0);
    } finally {
      opened.cleanup();
    }
  });

  it('rolls back if capability initialization fails after earlier inserts and then allows a clean retry', () => {
    const opened = openFileDatabase('rollback');
    try {
      const rolledBack = ingestAndPersist({
        database: opened.database,
        artifacts: prodRollbackArtifacts(),
        environment: 'prod',
        recordedAt: '2026-10-16T16:01:07.539Z',
      });
      expect(rolledBack.ok).toBe(false);
      if (rolledBack.ok) throw new Error('expected rollback');
      expect(rolledBack.error.kind).toBe('config_group_missing');
      expect(userTables(opened.database)).toEqual([]);
      const clean = ingestAndPersist({
        database: opened.database,
        artifacts: fixtureArtifacts(),
        environment: 'prod',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(clean.ok).toBe(true);
    } finally {
      opened.cleanup();
    }
  });

  it('preserves original directory attribution so later reloads still classify directory drift correctly', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('baseline failed');
      const originalDirectorySha = result.value.result.report.artifacts.find(
        (artifact) => artifact.source === 'directory',
      )?.sha256;
      expect(originalDirectorySha).toBeDefined();
      const drifted = ingestAndPersist({
        database: opened.database,
        artifacts: directoryChangedArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-18T00:00:00.000Z',
      });
      expect(drifted.ok).toBe(true);
      if (!drifted.ok) throw new Error('drifted run failed');
      expect(drifted.value.status).toBe('complete_with_exclusions');
      const reloaded = loadPriorState(opened.database);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) throw new Error('reload failed');
      expect(
        [...reloaded.value.active.values()].every(
          (row) => row.directorySha256 === originalDirectorySha,
        ),
      ).toBe(true);
      const replay = ingest(directoryChangedArtifacts(), reloaded.value);
      const restatements = replay.report.rows.filter(
        (row) => row.disposition.kind === 'restatement',
      );
      expect(restatements.length).toBeGreaterThan(0);
      expect(
        restatements.every(
          (row) =>
            row.disposition.kind === 'restatement' &&
            row.disposition.reason === 'directory_changed',
        ),
      ).toBe(true);
    } finally {
      opened.cleanup();
    }
  });

  it('does not persist emails, raw source keys, or raw vendor payload text', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const values = scanTextValues(opened.database);
      const text = values.join('\n');
      for (const user of fixtureDirectory().users) {
        expect(text.includes(user.email)).toBe(false);
      }
      expect(values.some((value) => value.includes('@'))).toBe(false);
      expect(text.includes(first(geminiLines(FIXTURE.gemini)))).toBe(false);
      expect(text.includes(JSON.stringify(first(claudeRows(FIXTURE.claudeUsage))))).toBe(false);
    } finally {
      opened.cleanup();
    }
  });

  it('uses the intended reporting indexes and returns deterministic filtered counts', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const usageRow = opened.database.sqlite
        .prepare<
          [],
          {
            readonly platform: string;
            readonly period_day: string;
            readonly group_id: string;
            readonly user_id: string;
            readonly iso_week: string;
          }
        >(
          'select platform, period_day, group_id, user_id, iso_week from usage_observations order by key_digest, ordinal limit 1',
        )
        .get();
      const chargeRow = opened.database.sqlite
        .prepare<
          [],
          {
            readonly platform: string;
            readonly period_day: string;
            readonly group_id: string;
            readonly iso_week: string;
          }
        >(
          'select platform, period_day, group_id, iso_week from charge_observations order by key_digest, ordinal limit 1',
        )
        .get();
      if (usageRow === undefined || chargeRow === undefined) {
        throw new Error('expected persisted observations');
      }
      const usagePlatformCount = opened.database.sqlite
        .prepare<[string, string], { readonly count: bigint }>(
          'select count(*) as count from usage_observations where platform = ? and period_day = ?',
        )
        .get(usageRow.platform, usageRow.period_day);
      const usageGroupCount = opened.database.sqlite
        .prepare<[string, string], { readonly count: bigint }>(
          'select count(*) as count from usage_observations where group_id = ? and period_day = ?',
        )
        .get(usageRow.group_id, usageRow.period_day);
      const usageUserCount = opened.database.sqlite
        .prepare<[string, string], { readonly count: bigint }>(
          'select count(*) as count from usage_observations where user_id = ? and period_day = ?',
        )
        .get(usageRow.user_id, usageRow.period_day);
      const usageWeekCount = opened.database.sqlite
        .prepare<[string, string, string], { readonly count: bigint }>(
          'select count(*) as count from usage_observations where platform = ? and group_id = ? and iso_week = ?',
        )
        .get(usageRow.platform, usageRow.group_id, usageRow.iso_week);
      const chargePlan = opened.database.sqlite
        .prepare<[string, string], { readonly detail: string }>(
          'explain query plan select * from charge_observations where platform = ? and period_day = ?',
        )
        .all(chargeRow.platform, chargeRow.period_day)
        .map((row) => row.detail);
      const usagePlan = opened.database.sqlite
        .prepare<[string, string], { readonly detail: string }>(
          'explain query plan select * from usage_observations where platform = ? and period_day = ?',
        )
        .all(usageRow.platform, usageRow.period_day)
        .map((row) => row.detail);
      expect(usagePlatformCount?.count).toBeGreaterThan(0n);
      expect(usageGroupCount?.count).toBeGreaterThan(0n);
      expect(usageUserCount?.count).toBeGreaterThan(0n);
      expect(usageWeekCount?.count).toBeGreaterThan(0n);
      expect(usagePlan.some((detail) => detail.includes('usage_platform_period_idx'))).toBe(true);
      expect(chargePlan.some((detail) => detail.includes('charge_platform_period_idx'))).toBe(true);
    } finally {
      opened.cleanup();
    }
  });

  it('never mutates the starter-kit fixtures', () => {
    expect(hashStarterFiles()).toEqual(STARTER_HASHES);
  });
});

function runFlags(database: ReturnType<typeof openMemoryDatabase>['database']): readonly {
  readonly status: string;
  readonly tokens: bigint;
  readonly money: bigint;
  readonly unmeasurable: bigint;
}[] {
  return database.sqlite
    .prepare<
      [],
      {
        readonly status: string;
        readonly tokens: bigint;
        readonly money: bigint;
        readonly unmeasurable: bigint;
      }
    >(
      'select status, exclusions_affect_tokens as tokens, exclusions_affect_money as money, exclusions_unmeasurable as unmeasurable from ingestion_runs order by id',
    )
    .all();
}

function geminiCostLexeme(line: string): string {
  const match = /"cost": ([0-9.]+)/.exec(line);
  if (match?.[1] === undefined) {
    throw new Error('gemini cost lexeme missing');
  }
  return match[1];
}

function claudeCostRestatementArtifacts() {
  const rows = claudeRows(FIXTURE.claudeCost);
  return fixtureArtifacts({
    claudeCost: claudeBytes([withFields(first(rows), { amount: '88.900051' }), ...rows.slice(1)]),
  });
}

const RECORDED_AT = '2026-10-16T16:01:07.539Z';

describe('review regressions: refused runs on a fresh database', () => {
  it('writes nothing for partial, failed and blocked runs, schema included', () => {
    const cases = [
      { status: 'partial', artifacts: partialArtifacts() },
      { status: 'failed', artifacts: failedArtifacts() },
      { status: 'blocked', artifacts: blockedArtifacts() },
    ] as const;
    for (const entry of cases) {
      const opened = openFileDatabase(`fresh-${entry.status}`);
      try {
        const before = hashDatabaseFiles(opened.path);
        const refused = ingestAndPersist({
          database: opened.database,
          artifacts: entry.artifacts,
          environment: 'dev',
          recordedAt: RECORDED_AT,
        });
        expect(refused).toEqual({
          ok: false,
          error: { kind: 'status_refused', status: entry.status },
        });
        expect(userTables(opened.database)).toEqual([]);
        expect(hashDatabaseFiles(opened.path)).toEqual(before);
        const clean = ingestAndPersist({
          database: opened.database,
          artifacts: fixtureArtifacts(),
          environment: 'dev',
          recordedAt: RECORDED_AT,
        });
        expect(clean.ok).toBe(true);
      } finally {
        opened.cleanup();
      }
    }
  });
});

describe('review regressions: exclusion metadata', () => {
  it('records no exclusion impact for a clean run', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      expect(runFlags(opened.database)).toEqual([
        { status: 'complete', tokens: 0n, money: 0n, unmeasurable: 0n },
      ]);
    } finally {
      opened.cleanup();
    }
  });

  it('records token and money impact when an excluded Gemini row carries both', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const excluded = ingestAndPersist({
        database: opened.database,
        artifacts: exclusionArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(excluded.ok).toBe(true);
      expect(runFlags(opened.database)[1]).toEqual({
        status: 'complete_with_exclusions',
        tokens: 1n,
        money: 1n,
        unmeasurable: 0n,
      });
    } finally {
      opened.cleanup();
    }
  });

  it('records money impact only when an excluded Claude cost row is restated', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const excluded = ingestAndPersist({
        database: opened.database,
        artifacts: claudeCostRestatementArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(excluded.ok).toBe(true);
      if (!excluded.ok) throw new Error('claude restatement run failed');
      expect(excluded.value.result.report.counts.restatements).toBe(1);
      expect(runFlags(opened.database)[1]).toEqual({
        status: 'complete_with_exclusions',
        tokens: 0n,
        money: 1n,
        unmeasurable: 0n,
      });
    } finally {
      opened.cleanup();
    }
  });
});

describe('review regressions: exact money through ingestAndPersist, close and reopen', () => {
  it('round-trips 2^53+1 and 2^63-1 e8 amounts and still replays', () => {
    const lines = geminiLines(FIXTURE.gemini);
    const targets = new Map<number, bigint>([
      [0, 9007199254740993n],
      [1, 9223372036854775807n],
    ]);
    const lexemes = new Map<number, string>([
      [0, '90071992.54740993'],
      [1, '92233720368.54775807'],
    ]);
    const edited = lines.map((line, index) => {
      const lexeme = lexemes.get(index);
      return lexeme === undefined
        ? line
        : line.replace(`"cost": ${geminiCostLexeme(line)}`, `"cost": ${lexeme}`);
    });
    const artifacts = fixtureArtifacts({ gemini: geminiBytes(edited) });
    const opened = openFileDatabase('money-exact');
    try {
      const persisted = ingestAndPersist({
        database: opened.database,
        artifacts,
        environment: 'dev',
        recordedAt: RECORDED_AT,
      });
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) throw new Error('persist failed');
      const expectedAmounts = new Set(
        [...persisted.value.result.state.active.values()]
          .flatMap((row) => row.observations)
          .flatMap((observation) => (observation.kind === 'charge' ? [observation.amount] : [])),
      );
      for (const target of targets.values()) {
        expect(expectedAmounts.has(target)).toBe(true);
      }
      opened.database.close();

      const reopened = openPersistenceDatabase(opened.path);
      try {
        const stored = reopened.sqlite
          .prepare<[], { readonly amount: bigint; readonly type: string }>(
            'select amount_usd_e8 as amount, typeof(amount_usd_e8) as type from charge_observations',
          )
          .all();
        expect(stored.every((row) => row.type === 'integer')).toBe(true);
        const storedAmounts = new Set(stored.map((row) => row.amount));
        for (const target of targets.values()) {
          expect(storedAmounts.has(target)).toBe(true);
        }
        const reloaded = loadPriorState(reopened);
        expect(reloaded.ok).toBe(true);
        if (!reloaded.ok) throw new Error('reload failed');
        const reloadedAmounts = new Set(
          [...reloaded.value.active.values()]
            .flatMap((row) => row.observations)
            .flatMap((observation) => (observation.kind === 'charge' ? [observation.amount] : [])),
        );
        expect(reloadedAmounts).toEqual(expectedAmounts);
        const replay = ingest(artifacts, reloaded.value);
        expect(replay.report.status).toBe('complete');
        expect(replay.report.counts.accepted).toBe(0);
        expect(replay.report.counts.restatements).toBe(0);
        expect(replay.state.active).toEqual(persisted.value.result.state.active);
      } finally {
        reopened.close();
      }
    } finally {
      opened.cleanup();
    }
  }, 15_000);
});

describe('review regressions: privacy of database and WAL bytes', () => {
  it('keeps emails, raw keys and vendor payload material out of DB and WAL bytes', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const excluded = ingestAndPersist({
        database: opened.database,
        artifacts: exclusionArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(excluded.ok).toBe(true);
      const restated = ingestAndPersist({
        database: opened.database,
        artifacts: claudeCostRestatementArtifacts(),
        environment: 'dev',
        recordedAt: '2026-10-17T01:00:00.000Z',
      });
      expect(restated.ok).toBe(true);

      const fragments = [
        ...fixtureDirectory().users.map((user) => user.email),
        '@meridianls.example',
        '["claude_usage",',
        '["claude_cost",',
        '["gemini_billing",',
        '01A2B3-C4D5E6-F7A8B9',
        'rbac_group_33DEEC83113481C9BD69498282',
        'meridian-clinops-prod',
        'D41E-77B0-2C1A',
        'Vertex AI',
        'billing_account_id',
        'usage_start_time',
        'inference_geo',
        'context_window',
        first(geminiLines(FIXTURE.gemini)).slice(0, 80),
      ];
      const walPath = `${opened.path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      const scanFiles = (): void => {
        for (const file of [opened.path, walPath]) {
          if (!existsSync(file)) {
            continue;
          }
          const bytes = readFileSync(file);
          for (const fragment of fragments) {
            expect(bytes.includes(Buffer.from(fragment, 'utf8')), `${file} leaks ${fragment}`).toBe(
              false,
            );
          }
        }
      };
      scanFiles();
      opened.database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      scanFiles();
    } finally {
      opened.cleanup();
    }
  });
});

describe('review regressions: missing prior keys', () => {
  it('keeps prior active rows and observations when a later artifact omits a key', () => {
    const { opened, result } = persistFixture('dev');
    try {
      expect(result.ok).toBe(true);
      const before = usageCounts(opened.database);
      const keysBefore = opened.database.sqlite
        .prepare<[], { readonly key: string }>(
          'select key_digest as key from active_source_rows order by key_digest',
        )
        .all();
      const lines = geminiLines(FIXTURE.gemini);
      const later = ingestAndPersist({
        database: opened.database,
        artifacts: fixtureArtifacts({ gemini: geminiBytes(lines.slice(0, -1)) }),
        environment: 'dev',
        recordedAt: '2026-10-17T00:00:00.000Z',
      });
      expect(later.ok).toBe(true);
      if (!later.ok) throw new Error('later run failed');
      expect(later.value.result.report.counts.priorKeysAbsent).toBeGreaterThan(0);
      expect(later.value.result.report.counts.accepted).toBe(0);
      const after = usageCounts(opened.database);
      expect({ ...after, capabilities: 0n }).toEqual({ ...before, capabilities: 0n });
      expect(
        opened.database.sqlite
          .prepare<[], { readonly key: string }>(
            'select key_digest as key from active_source_rows order by key_digest',
          )
          .all(),
      ).toEqual(keysBefore);
      const reloaded = loadPriorState(opened.database);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) throw new Error('reload failed');
      expect(reloaded.value.active.size).toBe(keysBefore.length);
    } finally {
      opened.cleanup();
    }
  });
});
