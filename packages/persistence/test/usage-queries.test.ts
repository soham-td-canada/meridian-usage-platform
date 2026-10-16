import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateGroupUsage,
  applyMigrations,
  hasIngestionRun,
  ingestAndPersist,
  rankGroupUsers,
  type PersistenceDatabase,
} from '../src/index.js';
import { expectedUsage } from './expected-usage.js';
import { fixtureArtifacts, openMemoryDatabase, type OpenedDatabase } from './helpers.js';

const opened: OpenedDatabase[] = [];

function seeded(): PersistenceDatabase {
  const handle = openMemoryDatabase();
  opened.push(handle);
  const result = ingestAndPersist({
    database: handle.database,
    artifacts: fixtureArtifacts(),
    environment: 'dev',
    recordedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(result.ok).toBe(true);
  return handle.database;
}

afterEach(() => {
  for (const handle of opened.splice(0)) {
    handle.cleanup();
  }
});

const GROUPS = ['clinical-operations', 'finance', 'hr', 'it-platform'] as const;
const WINDOWS = [
  ['2026-08-03', '2026-09-28'],
  ['2026-08-31', '2026-09-07'],
  ['2026-09-21', '2026-09-28'],
  ['2026-08-29', '2026-09-28'],
  ['2026-09-01', '2026-09-02'],
] as const;

describe('usage queries', () => {
  it.each(GROUPS.flatMap((group) => WINDOWS.map(([start, end]) => [group, start, end] as const)))(
    'aggregates %s over [%s, %s) exactly',
    (groupId, startDay, endExclusiveDay) => {
      const database = seeded();
      const expected = expectedUsage(groupId, startDay, endExclusiveDay);
      const aggregates = aggregateGroupUsage(database, { groupId, startDay, endExclusiveDay });
      expect(aggregates.ok).toBe(true);
      if (!aggregates.ok) {
        return;
      }
      const claude = aggregates.value.find((row) => row.platform === 'claude');
      const gemini = aggregates.value.find((row) => row.platform === 'gemini');
      // A platform with no rows is omitted rather than reported as zero.
      if (expected.claudeInput === 0n && expected.claudeCostE8 === 0n) {
        expect(claude).toBeUndefined();
      } else {
        expect(claude?.inputTokens).toBe(expected.claudeInput);
        expect(claude?.outputTokens).toBe(expected.claudeOutput);
        expect(claude?.requests).toBe(expected.claudeRequests);
        expect(claude?.costE8).toBe(expected.claudeCostE8);
      }
      if (expected.geminiInput === 0n && expected.geminiOutput === 0n) {
        expect(gemini).toBeUndefined();
      } else {
        expect(gemini?.requests).toBeNull();
        expect(gemini?.inputTokens).toBe(expected.geminiInput);
        expect(gemini?.outputTokens).toBe(expected.geminiOutput);
        expect(gemini?.costE8).toBe(expected.geminiCostE8);
      }
    },
  );

  it('ranks users by total tokens with a deterministic tie-break and exact cost', () => {
    const database = seeded();
    const expected = expectedUsage('it-platform', '2026-08-03', '2026-09-28');
    const ranked = rankGroupUsers(database, {
      groupId: 'it-platform',
      startDay: '2026-08-03',
      endExclusiveDay: '2026-09-28',
    });
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value).toHaveLength(expected.users.size);
    for (const user of ranked.value) {
      expect(user.totalTokens).toBe(expected.users.get(user.userId)?.tokens);
      expect(user.costE8).toBe(expected.users.get(user.userId)?.costE8);
    }
    const tokens = ranked.value.map((user) => user.totalTokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1)));
  });

  it('honors [start, end): the end day is excluded and the start day included', () => {
    const database = seeded();
    const one = aggregateGroupUsage(database, {
      groupId: 'finance',
      startDay: '2026-09-01',
      endExclusiveDay: '2026-09-02',
    });
    const empty = aggregateGroupUsage(database, {
      groupId: 'finance',
      startDay: '2026-09-01',
      endExclusiveDay: '2026-09-01',
    });
    expect(one.ok && one.value.length > 0).toBe(true);
    expect(empty).toEqual({ ok: true, value: [] });
  });

  it('returns nothing, not zeros, for windows or groups without rows', () => {
    const database = seeded();
    for (const groupId of ['finance', 'no-such-group']) {
      const window = { groupId, startDay: '2020-01-01', endExclusiveDay: '2020-02-01' };
      expect(aggregateGroupUsage(database, window)).toEqual({ ok: true, value: [] });
      expect(rankGroupUsers(database, window)).toEqual({ ok: true, value: [] });
    }
  });

  it('reports whether an ingestion run exists', () => {
    const handle = openMemoryDatabase();
    opened.push(handle);
    applyMigrations(handle.database);
    expect(hasIngestionRun(handle.database)).toEqual({ ok: true, value: false });
    expect(hasIngestionRun(seeded())).toEqual({ ok: true, value: true });
  });

  it('refuses to invent zero cost when charge rows are missing', () => {
    const database = seeded();
    database.sqlite.exec("DELETE FROM charge_observations WHERE platform = 'gemini'");
    const window = {
      groupId: 'finance',
      startDay: '2026-08-03',
      endExclusiveDay: '2026-09-28',
    };
    expect(aggregateGroupUsage(database, window)).toEqual({
      ok: false,
      error: { kind: 'cost_incomplete' },
    });
    database.sqlite.exec('DELETE FROM charge_observations');
    expect(rankGroupUsers(database, window)).toEqual({
      ok: false,
      error: { kind: 'cost_incomplete' },
    });
  });
});
