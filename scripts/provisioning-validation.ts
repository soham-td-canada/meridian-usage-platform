import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENVIRONMENTS,
  defaultCapabilityEnabledForGroup,
  type Environment,
} from '../packages/config/src/index.js';
import { CAPABILITIES } from '../packages/domain/src/index.js';
import { listCapabilityState, openPersistenceDatabase } from '../packages/persistence/src/index.js';
import { STARTER_KIT_DIR, loadTrustedDirectory } from '../apps/api/src/index.js';
import { SERVER_NAMES, claudePluginDir, geminiExtensionDir } from '../apps/mcp/src/provisioning.js';
import { provisionEnvironment } from './provision-environment.js';

const RECORDED_AT = '2026-10-01T00:00:00.000Z';
const packageFiles = (environment: Environment): readonly string[] => [
  `${claudePluginDir(environment)}/.claude-plugin/plugin.json`,
  `${claudePluginDir(environment)}/.mcp.json`,
  `${claudePluginDir(environment)}/launch.mjs`,
  `${claudePluginDir(environment)}/skills/meridian-usage/SKILL.md`,
  `${geminiExtensionDir(environment)}/gemini-extension.json`,
  `${geminiExtensionDir(environment)}/launch.mjs`,
  `${geminiExtensionDir(environment)}/GEMINI.md`,
];
const filesFor = (environment: Environment): readonly string[] => [
  'permissions.json',
  'claude.mcp.json',
  'gemini.settings.json',
  'meridian.sqlite',
  ...packageFiles(environment),
];
const textFilesFor = (environment: Environment): readonly string[] =>
  filesFor(environment).filter((name) => !name.endsWith('.sqlite'));

/** Filesystem failures surface as problems too, never as an unhandled crash that could pass silently. */
function provision(root: string, environment: string): string | undefined {
  try {
    return provisionEnvironment({ environment, rootDir: root, recordedAt: RECORDED_AT });
  } catch (cause: unknown) {
    return cause instanceof Error ? cause.message : 'unknown failure';
  }
}

function yamlServerName(environment: Environment): string | undefined {
  const yaml = readFileSync(join(STARTER_KIT_DIR, 'environments', `${environment}.yaml`), 'utf8');
  return /^\s*server_name:\s*(\S+)\s*$/m.exec(yaml)?.[1];
}

function snapshot(root: string, environment: Environment): readonly string[] {
  return textFilesFor(environment).map((name) =>
    readFileSync(join(root, 'generated', environment, name), 'utf8'),
  );
}

function checkEnvironment(root: string, environment: Environment): string[] {
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${environment}: ${message}`);
  };
  const error = provision(root, environment);
  if (error !== undefined) {
    return [`${environment}: provisioning failed: ${error}`];
  }
  for (const name of filesFor(environment)) {
    if (!existsSync(join(root, 'generated', environment, name))) {
      fail(`missing ${name}`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }

  const first = snapshot(root, environment);
  if (provision(root, environment) !== undefined) {
    fail('re-provisioning failed');
  } else if (snapshot(root, environment).some((content, index) => content !== first[index])) {
    fail('re-provisioning changed generated files');
  }

  if (yamlServerName(environment) !== SERVER_NAMES[environment]) {
    fail('server name differs from starter-kit environment yaml');
  }
  for (const [index, name] of textFilesFor(environment).entries()) {
    if (
      name.endsWith('.json') &&
      name !== 'permissions.json' &&
      !(first[index] ?? '').includes(`"${SERVER_NAMES[environment]}"`)
    ) {
      fail(`${name} does not register ${SERVER_NAMES[environment]}`);
    }
    if (name.endsWith('.json')) {
      try {
        JSON.parse(first[index] ?? '');
      } catch {
        fail(`${name} is not valid JSON`);
      }
    }
  }

  const directory = loadTrustedDirectory(STARTER_KIT_DIR);
  if (!directory.ok) {
    fail('directory could not be loaded');
    return problems;
  }
  const database = openPersistenceDatabase(join(root, 'generated', environment, 'meridian.sqlite'));
  const rows = listCapabilityState(database);
  database.close();
  if (!rows.ok) {
    fail('capability state unreadable');
    return problems;
  }
  const groups = [...directory.value.groupsById.keys()];
  if (rows.value.length !== groups.length * CAPABILITIES.length) {
    fail('capability row count is wrong');
  }
  for (const groupId of groups) {
    for (const capability of CAPABILITIES) {
      const row = rows.value.find((r) => r.groupId === groupId && r.capability === capability);
      if (row?.enabled !== defaultCapabilityEnabledForGroup(environment, capability, groupId)) {
        fail(`default for ${groupId}/${capability} is wrong`);
      }
    }
  }
  return problems;
}

/** Provisions every environment into a scratch root and returns all problems found (empty = valid). */
export function validateProvisioning(rootDir?: string): string[] {
  const owned = rootDir === undefined;
  const root = rootDir ?? mkdtempSync(join(tmpdir(), 'meridian-validate-'));
  try {
    const problems = ENVIRONMENTS.flatMap((environment) => checkEnvironment(root, environment));
    if (provision(root, 'qa') === undefined) {
      problems.push('unknown environment was not rejected');
    }
    return problems;
  } finally {
    if (owned) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
