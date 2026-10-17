import {
  CAPABILITY_DEFAULTS,
  parseEnvironment,
  type Environment,
} from '../../../packages/config/src/index.js';
import {
  CAPABILITIES,
  fail,
  ok,
  type Result,
  type UserRole,
} from '../../../packages/domain/src/index.js';
import {
  mayTargetAnyGroup,
  roleHasScope,
  type Scope,
} from '../../../packages/authorization/src/index.js';

/** Mirrors `host.server_name` in starter-kit/environments/*.yaml; cross-checked by tests. */
export const SERVER_NAMES: Readonly<Record<Environment, string>> = {
  dev: 'meridian-usage-dev',
  staging: 'meridian-usage-staging',
  prod: 'meridian-usage',
};

export const SERVER_COMMAND = 'node';
export const SERVER_ARGS = [
  '--disable-warning=ExperimentalWarning',
  '--experimental-transform-types',
  '--import',
  './scripts/register-ts.mjs',
  'apps/mcp/src/main.ts',
] as const;

const ROLES: readonly UserRole[] = ['member', 'team_lead', 'platform_admin'];
const SCOPES: readonly Scope[] = ['usage:read', 'capabilities:write'];

export const databasePathFor = (environment: Environment): string =>
  `generated/${environment}/meridian.sqlite`;

export interface RenderedFile {
  /** Relative to `generated/<environment>/`. */
  readonly name: string;
  readonly content: string;
}

export interface RenderedProvisioning {
  readonly environment: Environment;
  readonly files: readonly RenderedFile[];
}

function permissionsManifest(environment: Environment): object {
  const scopes: Record<string, object> = {};
  for (const scope of SCOPES) {
    scopes[scope] = {
      roles: ROLES.filter((role) => roleHasScope(environment, role, scope)),
      ...(scope === 'usage:read'
        ? {
            group_visibility: mayTargetAnyGroup(environment, 'team_lead', scope)
              ? 'all'
              : 'own_group',
            platform_admin_group_visibility: 'all',
          }
        : {}),
    };
  }
  const defaults: Record<string, object> = {};
  for (const capability of CAPABILITIES) {
    const value = CAPABILITY_DEFAULTS[environment][capability];
    switch (value.kind) {
      case 'all':
        defaults[capability] = { enabled: value.enabled };
        break;
      case 'groups':
        defaults[capability] = { enabled_for: [...value.enabledGroupIds] };
        break;
    }
  }
  return {
    environment,
    server_name: SERVER_NAMES[environment],
    scopes,
    capability_defaults: defaults,
  };
}

/** Package roots sit at generated/<env>/<kind>/<server-name>, four levels below the repository. */
export const claudePluginDir = (environment: Environment): string =>
  `claude-plugin/${SERVER_NAMES[environment]}`;
export const geminiExtensionDir = (environment: Environment): string =>
  `gemini-extension/${SERVER_NAMES[environment]}`;

const PACKAGE_VERSION = '0.1.0';
const PACKAGE_DESCRIPTION =
  'Meridian Claude and Gemini usage/cost reporting and capability controls over MCP (stdio).';

const GUIDANCE = (environment: Environment): string =>
  [
    `Meridian usage tools (${environment}). Four tools are available:`,
    '',
    '- usage_summary(group?, period): period is required (last_7_days, last_30_days, an ISO week such as 2026-W36, or a month such as 2026-09).',
    '- top_users(group?, period, limit?): period is required; limit is 1-25.',
    '- capability_status(group?)',
    '- set_capability(group, capability, enabled)',
    '',
    'Identity, role and scopes are resolved server-side from MERIDIAN_ACTOR_USER_ID and the trusted directory.',
    'Never pass or invent identities, roles or scopes in tool arguments.',
    'A permission_denied result is final: report it as-is and do not retry with other groups or arguments.',
    '',
  ].join('\n');

const SKILL_MD = (environment: Environment): string =>
  [
    '---',
    'name: meridian-usage',
    'description: Query Meridian Claude/Gemini usage and cost, and read or change capability controls, through the meridian MCP tools.',
    '---',
    '',
    GUIDANCE(environment),
  ].join('\n');

function registration(
  environment: Environment,
  actorReference: string,
  extra: object,
  args: readonly string[] = SERVER_ARGS,
): object {
  return {
    mcpServers: {
      [SERVER_NAMES[environment]]: {
        ...extra,
        command: SERVER_COMMAND,
        args: [...args],
        env: {
          MERIDIAN_ENV: environment,
          MERIDIAN_DB_PATH: databasePathFor(environment),
          MERIDIAN_ACTOR_USER_ID: actorReference,
        },
      },
    },
  };
}

/**
 * Packages launch through this file instead of `..` arguments: Node resolves the entry point's real
 * path, so the repository root is found even when a host symlinks the package into its own directory.
 */
const LAUNCHER = [
  "import { register } from 'node:module';",
  "register(new URL('../../../../scripts/ts-resolver.mjs', import.meta.url));",
  "await import(new URL('../../../../apps/mcp/src/main.ts', import.meta.url).href);",
  '',
].join('\n');

const packageArgs = (root: string): readonly string[] => [
  ...SERVER_ARGS.slice(0, 2),
  `${root}/launch.mjs`,
];

const CLAUDE_ROOT = '${CLAUDE_PLUGIN_ROOT}';
const GEMINI_ROOT = '${extensionPath}';

const json = (value: object): string => `${JSON.stringify(value, null, 2)}\n`;

/** Pure and timestamp-free: identical input always renders identical bytes. */
export function renderProvisioning(rawEnvironment: string): Result<RenderedProvisioning, string> {
  const parsed = parseEnvironment(rawEnvironment);
  if (!parsed.ok) {
    return fail('unknown environment');
  }
  const environment = parsed.value;
  return ok({
    environment,
    files: [
      { name: 'permissions.json', content: json(permissionsManifest(environment)) },
      {
        name: 'claude.mcp.json',
        content: json(registration(environment, '${MERIDIAN_ACTOR_USER_ID}', { type: 'stdio' })),
      },
      {
        name: 'gemini.settings.json',
        content: json(registration(environment, '$MERIDIAN_ACTOR_USER_ID', { trust: false })),
      },
      {
        name: `${claudePluginDir(environment)}/.claude-plugin/plugin.json`,
        content: json({
          name: SERVER_NAMES[environment],
          version: PACKAGE_VERSION,
          description: PACKAGE_DESCRIPTION,
        }),
      },
      {
        name: `${claudePluginDir(environment)}/.mcp.json`,
        content: json(
          registration(
            environment,
            '${MERIDIAN_ACTOR_USER_ID}',
            { type: 'stdio' },
            packageArgs(CLAUDE_ROOT),
          ),
        ),
      },
      { name: `${claudePluginDir(environment)}/launch.mjs`, content: LAUNCHER },
      {
        name: `${claudePluginDir(environment)}/skills/meridian-usage/SKILL.md`,
        content: SKILL_MD(environment),
      },
      {
        name: `${geminiExtensionDir(environment)}/gemini-extension.json`,
        content: json({
          name: SERVER_NAMES[environment],
          version: PACKAGE_VERSION,
          description: PACKAGE_DESCRIPTION,
          contextFileName: 'GEMINI.md',
          // Gemini CLI only passes declared variables to extension servers, and ignores `trust` here.
          settings: [
            {
              name: 'Meridian actor user id',
              description:
                'Directory user id the server acts as (never taken from tool arguments).',
              envVar: 'MERIDIAN_ACTOR_USER_ID',
            },
          ],
          ...registration(environment, '$MERIDIAN_ACTOR_USER_ID', {}, packageArgs(GEMINI_ROOT)),
        }),
      },
      { name: `${geminiExtensionDir(environment)}/launch.mjs`, content: LAUNCHER },
      { name: `${geminiExtensionDir(environment)}/GEMINI.md`, content: GUIDANCE(environment) },
    ],
  });
}
