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

function registration(environment: Environment, actorReference: string, extra: object): object {
  return {
    mcpServers: {
      [SERVER_NAMES[environment]]: {
        ...extra,
        command: SERVER_COMMAND,
        args: [...SERVER_ARGS],
        env: {
          MERIDIAN_ENV: environment,
          MERIDIAN_DB_PATH: databasePathFor(environment),
          MERIDIAN_ACTOR_USER_ID: actorReference,
        },
      },
    },
  };
}

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
    ],
  });
}
