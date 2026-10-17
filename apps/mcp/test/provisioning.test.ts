import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CAPABILITY_DEFAULTS,
  ENVIRONMENTS,
  type Environment,
} from '../../../packages/config/src/index.js';
import { CAPABILITIES } from '../../../packages/domain/src/index.js';
import { openPersistenceDatabase } from '../../../packages/persistence/src/index.js';
import { REPO_ROOT } from '../../api/src/index.js';
import { loadDirectoryOrThrow, userWith, withEnvironment } from '../../api/test/helpers.js';
import { provisionEnvironment } from '../../../scripts/provision-environment.js';
import {
  SERVER_ARGS,
  SERVER_COMMAND,
  SERVER_NAMES,
  claudePluginDir,
  databasePathFor,
  geminiExtensionDir,
  renderProvisioning,
} from '../src/provisioning.js';

const RECORDED_AT = '2026-10-01T00:00:00.000Z';
const roots: string[] = [];
const directoryNameOf = (path: string): string => path.split('/').slice(-1)[0] ?? '';

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'meridian-provision-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function yamlOf(environment: Environment): string {
  return readFileSync(join(REPO_ROOT, `starter-kit/environments/${environment}.yaml`), 'utf8');
}

function fileOf(environment: Environment, name: string): string {
  const rendered = renderProvisioning(environment);
  const file = rendered.ok
    ? rendered.value.files.find((candidate) => candidate.name === name)
    : undefined;
  if (file === undefined) {
    throw new Error(`missing ${name}`);
  }
  return file.content;
}

function listOf(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

describe('rendering', () => {
  it.each(ENVIRONMENTS)('renders deterministic registration for %s', (environment) => {
    const first = renderProvisioning(environment);
    const second = renderProvisioning(environment);
    expect(first).toEqual(second);
    expect(first.ok && first.value.files.map((file) => file.name)).toEqual([
      'permissions.json',
      'claude.mcp.json',
      'gemini.settings.json',
      `${claudePluginDir(environment)}/.claude-plugin/plugin.json`,
      `${claudePluginDir(environment)}/.mcp.json`,
      `${claudePluginDir(environment)}/launch.mjs`,
      `${claudePluginDir(environment)}/skills/meridian-usage/SKILL.md`,
      `${geminiExtensionDir(environment)}/gemini-extension.json`,
      `${geminiExtensionDir(environment)}/launch.mjs`,
      `${geminiExtensionDir(environment)}/GEMINI.md`,
    ]);
    const env = {
      MERIDIAN_ENV: environment,
      MERIDIAN_DB_PATH: databasePathFor(environment),
    };
    const claude = JSON.parse(fileOf(environment, 'claude.mcp.json')) as unknown;
    const gemini = JSON.parse(fileOf(environment, 'gemini.settings.json')) as unknown;
    expect(claude).toEqual({
      mcpServers: {
        [SERVER_NAMES[environment]]: {
          type: 'stdio',
          command: SERVER_COMMAND,
          args: [...SERVER_ARGS],
          env: { ...env, MERIDIAN_ACTOR_USER_ID: '${MERIDIAN_ACTOR_USER_ID}' },
        },
      },
    });
    expect(gemini).toEqual({
      mcpServers: {
        [SERVER_NAMES[environment]]: {
          trust: false,
          command: SERVER_COMMAND,
          args: [...SERVER_ARGS],
          env: { ...env, MERIDIAN_ACTOR_USER_ID: '$MERIDIAN_ACTOR_USER_ID' },
        },
      },
    });
  });

  it('contains no timestamps, absolute paths, or literal identities', () => {
    const directory = loadDirectoryOrThrow();
    for (const environment of ENVIRONMENTS) {
      const rendered = renderProvisioning(environment);
      for (const file of rendered.ok ? rendered.value.files : []) {
        expect(file.content).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(file.content).not.toContain(REPO_ROOT);
        expect(file.content).not.toContain('/Users/');
        expect(file.content.endsWith('\n')).toBe(true);
        for (const user of directory.usersById.values()) {
          expect(file.content).not.toContain(user.userId);
        }
      }
    }
  });

  it.each(['', 'DEV', 'Prod', 'prod ', ' dev', 'production', 'qa', 'dev\n', '__proto__', '../dev'])(
    'fails closed for unknown environment %j',
    (raw) => {
      expect(renderProvisioning(raw)).toEqual({ ok: false, error: 'unknown environment' });
      const root = tempRoot();
      expect(
        provisionEnvironment({ environment: raw, rootDir: root, recordedAt: RECORDED_AT }),
      ).toBe('unknown environment');
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it.each(ENVIRONMENTS)(
    'server name and manifest for %s match the starter-kit YAML',
    (environment) => {
      const yaml = yamlOf(environment);
      expect(SERVER_NAMES[environment]).toBe(/server_name:\s*(\S+)/.exec(yaml)?.[1]);
      const manifest = JSON.parse(fileOf(environment, 'permissions.json')) as {
        environment: string;
        server_name: string;
        scopes: Record<string, { roles: string[]; group_visibility?: string }>;
        capability_defaults: Record<string, { enabled?: boolean; enabled_for?: string[] }>;
      };
      expect(manifest.environment).toBe(environment);
      expect(manifest.server_name).toBe(SERVER_NAMES[environment]);

      const readBlock = /usage:read:\s*\n\s*roles: \[(.*?)\]\s*\n\s*group_visibility:\s*(\w+)/.exec(
        yaml,
      );
      expect(manifest.scopes['usage:read']?.roles).toEqual(listOf(readBlock?.[1] ?? ''));
      expect(manifest.scopes['usage:read']?.group_visibility).toBe(readBlock?.[2]);
      const writeRoles = /capabilities:write:\s*\n\s*roles: \[(.*?)\]/.exec(yaml)?.[1];
      expect(manifest.scopes['capabilities:write']?.roles).toEqual(listOf(writeRoles ?? ''));

      const defaults = yaml.split('capability_defaults:')[1] ?? '';
      for (const capability of CAPABILITIES) {
        const entry = manifest.capability_defaults[capability];
        const enabledFor = new RegExp(`${capability}:\\s*\\n\\s*enabled_for: \\[(.*?)\\]`).exec(
          defaults,
        );
        if (enabledFor !== null) {
          expect(entry).toEqual({ enabled_for: listOf(enabledFor[1] ?? '') });
        } else {
          const simple = new RegExp(`${capability}:\\s*(enabled|disabled)`).exec(defaults);
          expect(entry).toEqual({ enabled: simple?.[1] === 'enabled' });
        }
      }
    },
  );
});

describe('platform packaging', () => {
  const launch = (root: string): string[] => [
    '--disable-warning=ExperimentalWarning',
    '--experimental-transform-types',
    `${root}/launch.mjs`,
  ];

  it.each(ENVIRONMENTS)('renders a Claude plugin and a Gemini extension for %s', (environment) => {
    const name = SERVER_NAMES[environment];
    const plugin = JSON.parse(
      fileOf(environment, `${claudePluginDir(environment)}/.claude-plugin/plugin.json`),
    ) as Record<string, unknown>;
    expect(plugin).toMatchObject({ name, version: '0.1.0' });
    expect(JSON.parse(fileOf(environment, `${claudePluginDir(environment)}/.mcp.json`))).toEqual({
      mcpServers: {
        [name]: {
          type: 'stdio',
          command: SERVER_COMMAND,
          args: launch('${CLAUDE_PLUGIN_ROOT}'),
          env: {
            MERIDIAN_ENV: environment,
            MERIDIAN_DB_PATH: databasePathFor(environment),
            MERIDIAN_ACTOR_USER_ID: '${MERIDIAN_ACTOR_USER_ID}',
          },
        },
      },
    });

    const extension = JSON.parse(
      fileOf(environment, `${geminiExtensionDir(environment)}/gemini-extension.json`),
    ) as Record<string, unknown>;
    expect(extension).toMatchObject({
      name,
      version: '0.1.0',
      contextFileName: 'GEMINI.md',
      settings: [{ envVar: 'MERIDIAN_ACTOR_USER_ID' }],
      mcpServers: {
        [name]: {
          command: SERVER_COMMAND,
          args: launch('${extensionPath}'),
          env: {
            MERIDIAN_ENV: environment,
            MERIDIAN_DB_PATH: databasePathFor(environment),
            MERIDIAN_ACTOR_USER_ID: '$MERIDIAN_ACTOR_USER_ID',
          },
        },
      },
    });
    // Gemini ignores `trust` in extensions, and no package may ever grant it.
    expect(JSON.stringify(extension)).not.toContain('trust');
    expect(directoryNameOf(geminiExtensionDir(environment))).toBe(name);
  });

  it.each(ENVIRONMENTS)('guidance for %s keeps the trust boundary and the period rule', (env) => {
    const context = fileOf(env, `${geminiExtensionDir(env)}/GEMINI.md`);
    const skill = fileOf(env, `${claudePluginDir(env)}/skills/meridian-usage/SKILL.md`);
    for (const text of [context, skill]) {
      expect(text).toContain('period is required');
      expect(text).toContain('Never pass or invent identities');
      expect(text).toContain('permission_denied');
    }
    expect(skill.startsWith('---\nname: meridian-usage\n')).toBe(true);
  });

  it.each(['claude', 'gemini'] as const)(
    'the %s package launches the real server through a symlink from an unrelated directory',
    (kind) => {
      const copy = tempRoot();
      const cwd = tempRoot();
      provisionEnvironment({ environment: 'dev', rootDir: copy, recordedAt: RECORDED_AT });
      for (const entry of ['apps', 'scripts', 'packages', 'starter-kit', 'node_modules']) {
        symlinkSync(join(REPO_ROOT, entry), join(copy, entry));
      }
      const packageDir = join(
        copy,
        'generated/dev',
        kind === 'claude' ? claudePluginDir('dev') : geminiExtensionDir('dev'),
      );
      // Hosts such as `gemini extensions link` expose the package through a symlink.
      const linked = join(cwd, SERVER_NAMES.dev);
      symlinkSync(packageDir, linked);
      const manifest = JSON.parse(
        readFileSync(
          join(packageDir, kind === 'claude' ? '.mcp.json' : 'gemini-extension.json'),
          'utf8',
        ),
      ) as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      };
      const server = manifest.mcpServers[SERVER_NAMES.dev];
      const member = userWith(loadDirectoryOrThrow(), 'member', 'hr').userId;
      const request = (name: string, args: object): string =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: args },
        });
      const result = spawnSync(
        server?.command ?? '',
        (server?.args ?? []).map((arg) =>
          arg.replace('${CLAUDE_PLUGIN_ROOT}', linked).replace('${extensionPath}', linked),
        ),
        {
          cwd,
          input: `${request('usage_summary', { period: '2026-W36' })}\n${request('set_capability', { group: 'hr', capability: 'web-search', enabled: false })}\n`,
          env: {
            PATH: process.env['PATH'] ?? '',
            ...server?.env,
            MERIDIAN_DB_PATH: relative(REPO_ROOT, join(copy, 'generated/dev/meridian.sqlite')),
            MERIDIAN_ACTOR_USER_ID: member,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(result.status).toBe(0);
      const [read, write] = result.stdout
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { result: { isError: boolean; content: { text: string }[] } },
        );
      // dev lets a member read, but only team leads and admins write.
      expect(read?.result.isError).toBe(false);
      expect(write?.result.isError).toBe(true);
      expect(JSON.parse(write?.result.content[0]?.text ?? '{}')).toMatchObject({
        error: 'permission_denied',
        code: 'scope_not_granted',
      });
    },
  );
});

describe('provisioning', () => {
  it.each(ENVIRONMENTS)(
    'provisions %s idempotently and preserves capability changes',
    (environment) => {
      const root = tempRoot();
      const outDir = join(root, 'generated', environment);
      expect(
        provisionEnvironment({ environment, rootDir: root, recordedAt: RECORDED_AT }),
      ).toBeUndefined();
      expect(
        readdirSync(outDir)
          .filter((name) => !name.startsWith('meridian.sqlite-'))
          .sort(),
      ).toEqual([
        'claude-plugin',
        'claude.mcp.json',
        'gemini-extension',
        'gemini.settings.json',
        'meridian.sqlite',
        'permissions.json',
      ]);
      const snapshot = (): Record<string, string> =>
        Object.fromEntries(
          ['claude.mcp.json', 'gemini.settings.json', 'permissions.json'].map((name) => [
            name,
            readFileSync(join(outDir, name), 'utf8'),
          ]),
        );
      const counts = (): readonly bigint[] => {
        const database = openPersistenceDatabase(join(outDir, 'meridian.sqlite'));
        try {
          return [
            'usage_observations',
            'charge_observations',
            'capability_state',
            'active_source_rows',
          ].map((table) => {
            const row = database.sqlite
              .prepare<[], { n: bigint }>(`SELECT COUNT(*) AS n FROM ${table}`)
              .get();
            return row?.n ?? -1n;
          });
        } finally {
          database.close();
        }
      };

      const filesBefore = snapshot();
      const countsBefore = counts();
      expect(countsBefore.every((count) => count > 0n)).toBe(true);

      const directory = loadDirectoryOrThrow();
      const database = openPersistenceDatabase(join(outDir, 'meridian.sqlite'));
      const admin = userWith(directory, 'platform_admin', 'it-platform').userId;
      const service = withEnvironment(database, directory, environment).service;
      const target = {
        group: 'hr',
        capability: 'code-execution',
        enabled: environment === 'dev' ? false : true,
      };
      expect(service.invoke(admin, 'set_capability', target).kind).toBe('ok');
      database.close();

      expect(
        provisionEnvironment({ environment, rootDir: root, recordedAt: RECORDED_AT }),
      ).toBeUndefined();
      expect(snapshot()).toEqual(filesBefore);
      expect(counts()).toEqual(countsBefore);

      const reopened = openPersistenceDatabase(join(outDir, 'meridian.sqlite'));
      try {
        const rows = reopened.sqlite
          .prepare<[], { group_id: string; capability: string; enabled: bigint }>(
            'SELECT group_id, capability, enabled FROM capability_state',
          )
          .all();
        expect(rows).toHaveLength(directory.groupsById.size * CAPABILITIES.length);
        for (const row of rows) {
          const definition =
            CAPABILITY_DEFAULTS[environment][row.capability as (typeof CAPABILITIES)[number]];
          const expected =
            row.group_id === 'hr' && row.capability === 'code-execution'
              ? target.enabled
              : definition.kind === 'all'
                ? definition.enabled
                : definition.enabledGroupIds.some((group) => group === row.group_id);
          expect(row.enabled === 1n).toBe(expected);
        }
      } finally {
        reopened.close();
      }
    },
  );
});

describe('rendered registrations launch a working server', () => {
  const root = tempRoot();
  const adminId = userWith(loadDirectoryOrThrow(), 'platform_admin', 'it-platform').userId;
  provisionEnvironment({ environment: 'dev', rootDir: root, recordedAt: RECORDED_AT });
  const databasePath = join(root, 'generated/dev/meridian.sqlite');

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'usage_summary', arguments: { period: '2026-W36' } },
    },
  ];

  function run(
    command: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
  ): { status: number | null; lines: Record<string, unknown>[] } {
    const result = spawnSync(command, args, {
      cwd,
      input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      env: { PATH: process.env['PATH'] ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return {
      status: result.status,
      lines: result.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  /** Emulates the host: expands the actor reference and points the database at the temp copy. */
  function launchFrom(file: string, key: 'claude' | 'gemini', actor: string | undefined) {
    const parsed = JSON.parse(fileOf('dev', file)) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = parsed.mcpServers[SERVER_NAMES.dev];
    expect(server).toBeDefined();
    expect(key.length).toBeGreaterThan(0);
    return run(server?.command ?? '', server?.args ?? [], REPO_ROOT, {
      ...server?.env,
      MERIDIAN_DB_PATH: relative(REPO_ROOT, databasePath),
      MERIDIAN_ACTOR_USER_ID: actor ?? '',
    });
  }

  it.each([
    ['claude.mcp.json', 'claude'],
    ['gemini.settings.json', 'gemini'],
  ] as const)('%s starts from the repo root and serves authorized calls', (file, key) => {
    const { status, lines } = launchFrom(file, key, adminId);
    expect(status).toBe(0);
    expect(lines).toHaveLength(2);
    expect((lines[0]?.['result'] as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'meridian-usage-dev',
    );
    const result = lines[1]?.['result'] as { isError: boolean };
    expect(result.isError).toBe(false);
  });

  it('denies structurally when the host supplies no actor', () => {
    const { lines } = launchFrom('claude.mcp.json', 'claude', undefined);
    const result = lines[1]?.['result'] as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      code: 'identity_unresolved',
    });
  });

  it('resolves the database independent of the working directory', () => {
    const other = tempRoot();
    const args = SERVER_ARGS.map((arg) =>
      arg.startsWith('./') || arg.startsWith('apps/') ? join(REPO_ROOT, arg) : arg,
    );
    const { status, lines } = run(SERVER_COMMAND, args, other, {
      MERIDIAN_ENV: 'dev',
      MERIDIAN_DB_PATH: relative(REPO_ROOT, databasePath),
      MERIDIAN_ACTOR_USER_ID: adminId,
    });
    expect(status).toBe(0);
    expect((lines[1]?.['result'] as { isError: boolean }).isError).toBe(false);
  });

  it('refuses to start for unknown environments or unprovisioned databases', () => {
    const args = [...SERVER_ARGS];
    for (const env of [
      { MERIDIAN_ENV: 'qa', MERIDIAN_DB_PATH: relative(REPO_ROOT, databasePath) },
      { MERIDIAN_ENV: '' },
      { MERIDIAN_ENV: 'dev', MERIDIAN_DB_PATH: join(tempRoot(), 'missing.sqlite') },
    ]) {
      const { status, lines } = run(SERVER_COMMAND, args, REPO_ROOT, env);
      expect(status).not.toBe(0);
      expect(lines).toEqual([]);
    }
    expect(existsSync(databasePath)).toBe(true);
  });
});
