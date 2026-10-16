import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_DEFAULTS } from '../../config/src/index.js';
import { CAPABILITIES } from '../../domain/src/index.js';
import {
  initializeCapabilityState,
  listCapabilityState,
  openPersistenceDatabase,
  setCapabilityState,
} from '../src/index.js';
import {
  fixtureDirectory,
  hashDatabaseFiles,
  openFileDatabase,
  openMemoryDatabase,
  seedGroups,
} from './helpers.js';

const STARTER_ENVS = join(process.cwd(), 'starter-kit/environments');

function expectedEnabledFromYaml(
  environment: 'dev' | 'staging' | 'prod',
  groupId: string,
  capability: string,
): boolean {
  const text = readFileSync(join(STARTER_ENVS, `${environment}.yaml`), 'utf8');
  const defaultsSection = text.split('capability_defaults:')[1];
  if (defaultsSection === undefined) {
    throw new Error('missing capability_defaults');
  }
  if (capability === 'usage-connector' && environment === 'prod') {
    const enabledForBlock = defaultsSection.split('enabled_for: [')[1]?.split(']')[0];
    if (enabledForBlock === undefined) {
      throw new Error('missing prod enabled_for');
    }
    return enabledForBlock
      .split(',')
      .map((value) => value.trim())
      .includes(groupId);
  }
  const line = defaultsSection
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${capability}:`));
  if (line === undefined) {
    throw new Error(`missing line for ${capability}`);
  }
  return line.endsWith('enabled');
}

describe('capability defaults and repository', () => {
  it('matches starter-kit YAML defaults exactly for dev, staging, and prod', () => {
    const { groups } = fixtureDirectory();
    for (const environment of ['dev', 'staging', 'prod'] as const) {
      for (const group of groups) {
        for (const capability of CAPABILITIES) {
          const fromTyped = (() => {
            const definition = CAPABILITY_DEFAULTS[environment][capability];
            switch (definition.kind) {
              case 'all':
                return definition.enabled;
              case 'groups':
                return definition.enabledGroupIds.some((candidate) => candidate === group.groupId);
            }
          })();
          expect(fromTyped).toBe(expectedEnabledFromYaml(environment, group.groupId, capability));
        }
      }
    }
  });

  it('initializes exactly 18 rows for each environment and is idempotent', () => {
    const { groups } = fixtureDirectory();
    for (const environment of ['dev', 'staging', 'prod'] as const) {
      const opened = openMemoryDatabase();
      try {
        seedGroups(opened.database, groups);
        const first = initializeCapabilityState(opened.database, environment, groups);
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error('init failed');
        expect(first.value.createdRows).toBe(18);
        const second = initializeCapabilityState(opened.database, environment, groups);
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error('reinit failed');
        expect(second.value.createdRows).toBe(0);
        const rows = listCapabilityState(opened.database);
        expect(rows.ok).toBe(true);
        if (!rows.ok) throw new Error('list failed');
        expect(rows.value).toHaveLength(18);
      } finally {
        opened.cleanup();
      }
    }
  });

  it('does not overwrite existing admin-changed state and seeds new groups later', () => {
    const { groups } = fixtureDirectory();
    const opened = openMemoryDatabase();
    try {
      seedGroups(opened.database, groups.slice(0, 5));
      const first = initializeCapabilityState(opened.database, 'staging', groups.slice(0, 5));
      expect(first.ok).toBe(true);
      const changed = setCapabilityState(opened.database, {
        groupId: groups[0]?.groupId ?? 'missing',
        capability: 'code-execution',
        enabled: true,
        updatedAt: '2026-10-18T00:00:00.000Z',
        updatedBy: 'admin-1',
      });
      expect(changed.ok).toBe(true);
      if (!changed.ok) throw new Error('change failed');
      seedGroups(opened.database, groups.slice(5));
      const second = initializeCapabilityState(opened.database, 'staging', groups);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('seed failed');
      expect(second.value.createdRows).toBe(3);
      const rows = listCapabilityState(opened.database);
      expect(rows.ok).toBe(true);
      if (!rows.ok) throw new Error('list failed');
      expect(
        rows.value.find(
          (row) => row.groupId === changed.value.row.groupId && row.capability === 'code-execution',
        )?.enabled,
      ).toBe(true);
      expect(rows.value).toHaveLength(18);
    } finally {
      opened.cleanup();
    }
  });

  it('fails closed for unknown environments and missing prod default groups', () => {
    const { groups } = fixtureDirectory();
    const opened = openMemoryDatabase();
    try {
      seedGroups(opened.database, groups);
      const unknown = initializeCapabilityState(opened.database, 'qa', groups);
      expect(unknown).toEqual({
        ok: false,
        error: { kind: 'unknown_environment', environment: 'qa' },
      });
      const missing = initializeCapabilityState(
        opened.database,
        'prod',
        groups.filter((group) => group.groupId !== 'clinical-operations'),
      );
      expect(missing.ok).toBe(false);
      if (missing.ok) throw new Error('missing-group init should fail');
      expect(missing.error.kind).toBe('config_group_missing');
    } finally {
      opened.cleanup();
    }
  });

  it('supports updates, same-value no-op, typed errors, and reopen persistence', () => {
    const { groups } = fixtureDirectory();
    const opened = openFileDatabase('capability-state');
    try {
      seedGroups(opened.database, groups);
      const initial = initializeCapabilityState(opened.database, 'prod', groups);
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw new Error('init failed');
      const changed = setCapabilityState(opened.database, {
        groupId: groups[0]?.groupId ?? 'missing',
        capability: 'code-execution',
        enabled: true,
        updatedAt: '2026-10-18T00:00:00.000Z',
        updatedBy: 'admin-2',
      });
      expect(changed.ok).toBe(true);
      if (!changed.ok) throw new Error('change failed');
      expect(changed.value.changed).toBe(true);
      expect(changed.value.row.updatedAt).toBe('2026-10-18T00:00:00.000Z');
      expect(changed.value.row.updatedBy).toBe('admin-2');
      const noop = setCapabilityState(opened.database, {
        groupId: changed.value.row.groupId,
        capability: changed.value.row.capability,
        enabled: true,
        updatedAt: '2026-10-19T00:00:00.000Z',
        updatedBy: 'admin-3',
      });
      expect(noop.ok).toBe(true);
      if (!noop.ok) throw new Error('noop failed');
      expect(noop.value.changed).toBe(false);
      expect(noop.value.row.updatedAt).toBe('2026-10-18T00:00:00.000Z');
      expect(
        setCapabilityState(opened.database, {
          groupId: 'missing-group',
          capability: 'code-execution',
          enabled: true,
          updatedAt: '2026-10-18T00:00:00.000Z',
          updatedBy: 'admin-2',
        }),
      ).toEqual({ ok: false, error: { kind: 'unknown_group', groupId: 'missing-group' } });
      expect(
        setCapabilityState(opened.database, {
          groupId: changed.value.row.groupId,
          capability: 'web_search',
          enabled: true,
          updatedAt: '2026-10-18T00:00:00.000Z',
          updatedBy: 'admin-2',
        }),
      ).toEqual({ ok: false, error: { kind: 'unknown_capability', capability: 'web_search' } });
      const separate = openMemoryDatabase();
      try {
        seedGroups(separate.database, groups.slice(0, 1));
        expect(
          setCapabilityState(separate.database, {
            groupId: groups[0]?.groupId ?? 'missing',
            capability: 'web-search',
            enabled: false,
            updatedAt: '2026-10-18T00:00:00.000Z',
            updatedBy: 'admin-2',
          }),
        ).toEqual({
          ok: false,
          error: {
            kind: 'state_missing',
            groupId: groups[0]?.groupId ?? 'missing',
            capability: 'web-search',
          },
        });
      } finally {
        separate.cleanup();
      }
      opened.database.close();
      const reopened = openPersistenceDatabase(opened.path);
      try {
        const rows = listCapabilityState(reopened);
        expect(rows.ok).toBe(true);
        if (!rows.ok) throw new Error('reopen failed');
        expect(
          rows.value.find(
            (row) =>
              row.groupId === changed.value.row.groupId &&
              row.capability === changed.value.row.capability,
          )?.enabled,
        ).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      opened.cleanup();
    }
  });
});

describe('review regressions: capability mutation and initialization', () => {
  function seededFileDatabase(prefix: string) {
    const { groups } = fixtureDirectory();
    const opened = openFileDatabase(prefix);
    seedGroups(opened.database, groups);
    const initialized = initializeCapabilityState(opened.database, 'dev', groups);
    if (!initialized.ok) throw new Error('init failed');
    return { opened, groups };
  }

  it('unknown group and unknown capability write nothing', () => {
    const { opened, groups } = seededFileDatabase('cap-zero-write');
    try {
      const rowsBefore = listCapabilityState(opened.database);
      const bytesBefore = hashDatabaseFiles(opened.path);
      const groupId = groups[0]?.groupId ?? 'missing';
      const attempts = [
        { groupId: 'no-such-group', capability: 'web-search' },
        { groupId: 'No Such Group', capability: 'web-search' },
        { groupId, capability: 'Web-Search' },
        { groupId, capability: 'web_search' },
        { groupId, capability: ' web-search' },
      ] as const;
      for (const attempt of attempts) {
        const result = setCapabilityState(opened.database, {
          ...attempt,
          enabled: false,
          updatedAt: '2026-10-18T00:00:00.000Z',
          updatedBy: 'admin-1',
        });
        expect(result.ok).toBe(false);
        expect(listCapabilityState(opened.database)).toEqual(rowsBefore);
        expect(hashDatabaseFiles(opened.path)).toEqual(bytesBefore);
      }
    } finally {
      opened.cleanup();
    }
  });

  it('same-value set is a true no-op and a real change writes exactly one row', () => {
    const { opened, groups } = seededFileDatabase('cap-noop');
    try {
      const groupId = groups[0]?.groupId ?? 'missing';
      const rowsBefore = listCapabilityState(opened.database);
      const bytesBefore = hashDatabaseFiles(opened.path);
      const same = setCapabilityState(opened.database, {
        groupId,
        capability: 'web-search',
        enabled: true,
        updatedAt: '2026-10-18T00:00:00.000Z',
        updatedBy: 'admin-1',
      });
      expect(same.ok && !same.value.changed && same.value.row.updatedAt === null).toBe(true);
      expect(listCapabilityState(opened.database)).toEqual(rowsBefore);
      expect(hashDatabaseFiles(opened.path)).toEqual(bytesBefore);

      const flipped = setCapabilityState(opened.database, {
        groupId,
        capability: 'web-search',
        enabled: false,
        updatedAt: '2026-10-18T00:00:00.000Z',
        updatedBy: 'admin-1',
      });
      expect(flipped.ok && flipped.value.changed).toBe(true);
      const rowsAfter = listCapabilityState(opened.database);
      if (!rowsBefore.ok || !rowsAfter.ok) throw new Error('list failed');
      expect(
        rowsAfter.value.filter(
          (row, index) => JSON.stringify(row) !== JSON.stringify(rowsBefore.value[index]),
        ),
      ).toHaveLength(1);
      expect(rowsAfter.value.filter((row) => row.updatedBy !== null)).toHaveLength(1);
    } finally {
      opened.cleanup();
    }
  });

  it('missing initialized state returns state_missing without writing', () => {
    const { groups } = fixtureDirectory();
    const opened = openFileDatabase('cap-state-missing');
    try {
      seedGroups(opened.database, groups);
      const bytesBefore = hashDatabaseFiles(opened.path);
      const result = setCapabilityState(opened.database, {
        groupId: groups[0]?.groupId ?? 'missing',
        capability: 'web-search',
        enabled: false,
        updatedAt: '2026-10-18T00:00:00.000Z',
        updatedBy: 'admin-1',
      });
      expect(result.ok ? undefined : result.error.kind).toBe('state_missing');
      expect(hashDatabaseFiles(opened.path)).toEqual(bytesBefore);
    } finally {
      opened.cleanup();
    }
  });

  it('stale extra groups cannot mask a missing row for a current group', () => {
    const { groups } = fixtureDirectory();
    const opened = openMemoryDatabase();
    try {
      seedGroups(opened.database, groups);
      opened.database.sqlite
        .prepare('insert into groups (group_id, name) values (?, ?)')
        .run('stale-group', 'Stale');
      const stale = [...groups, { groupId: 'stale-group', name: 'Stale' }] as typeof groups;
      expect(initializeCapabilityState(opened.database, 'dev', stale).ok).toBe(true);

      const victim = groups[0]?.groupId ?? 'missing';
      opened.database.sqlite
        .prepare('delete from capability_state where group_id = ? and capability = ?')
        .run(victim, 'web-search');
      opened.database.sqlite.exec(
        `create trigger swallow_insert before insert on capability_state
         when new.group_id = '${victim}' and new.capability = 'web-search'
         begin select raise(ignore); end`,
      );
      // 20 rows remain (>= 18 expected), so a whole-table count would wrongly pass.
      const blocked = initializeCapabilityState(opened.database, 'dev', groups);
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.error.kind).toBe('integrity_error');
      expect(!blocked.ok && 'message' in blocked.error && blocked.error.message).toContain(
        `${victim}/web-search`,
      );

      opened.database.sqlite.exec('drop trigger swallow_insert');
      const repaired = initializeCapabilityState(opened.database, 'dev', groups);
      expect(repaired.ok && repaired.value.createdRows).toBe(1);
    } finally {
      opened.cleanup();
    }
  });

  it('verifies the complete 18-row matrix for the current groups', () => {
    const { groups } = fixtureDirectory();
    const opened = openMemoryDatabase();
    try {
      seedGroups(opened.database, groups);
      const result = initializeCapabilityState(opened.database, 'prod', groups);
      expect(result.ok && result.value.totalRows).toBe(18);
      const rows = listCapabilityState(opened.database);
      if (!rows.ok) throw new Error('list failed');
      for (const group of groups) {
        for (const capability of CAPABILITIES) {
          expect(
            rows.value.filter(
              (row) => row.groupId === group.groupId && row.capability === capability,
            ),
          ).toHaveLength(1);
        }
      }
    } finally {
      opened.cleanup();
    }
  });
});
