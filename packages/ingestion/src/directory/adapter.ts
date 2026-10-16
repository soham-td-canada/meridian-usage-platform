import {
  buildDirectory,
  fail,
  parseClaudeRbacGroupId,
  parseEmailAddress,
  parseGcpProjectId,
  parseGroupId,
  parseUserId,
  type Directory,
  type DirectoryGroup,
  type DirectoryUser,
  type GroupId,
  type Result,
  type UserRole,
} from '@meridian/domain';
import { parseJsonWithLexemes } from '../shared/json.js';
import {
  arrayField,
  asRecord,
  booleanField,
  orReject,
  reject,
  RowStop,
  stringField,
  type JsonRecord,
} from '../shared/validate.js';

const ROLES: readonly UserRole[] = ['member', 'team_lead', 'platform_admin'];

function parseRole(raw: string): UserRole {
  const role = ROLES.find((candidate) => candidate === raw);
  if (role === undefined) {
    reject('schema', `unknown role ${raw}`);
  }
  return role;
}

function parseGroupIds(record: JsonRecord, label: string): readonly GroupId[] {
  return arrayField(record, 'group_ids', label).map((value) => {
    if (typeof value !== 'string') {
      reject('schema', `${label}.group_ids must contain strings`);
    }
    return orReject(parseGroupId(value), 'schema');
  });
}

function parseUser(raw: unknown, index: number): DirectoryUser {
  const label = `users[${String(index)}]`;
  const record = asRecord(raw, label);
  return {
    userId: orReject(parseUserId(stringField(record, 'user_id', label)), 'schema'),
    email: orReject(parseEmailAddress(stringField(record, 'email', label)), 'schema'),
    name: stringField(record, 'name', label),
    role: parseRole(stringField(record, 'role', label)),
    groupIds: parseGroupIds(record, label),
    claudeSeat: booleanField(record, 'claude_seat', label),
    gcpPrincipal: stringField(record, 'gcp_principal', label),
  };
}

function parseGroup(raw: unknown, index: number): DirectoryGroup {
  const label = `groups[${String(index)}]`;
  const record = asRecord(raw, label);
  return {
    groupId: orReject(parseGroupId(stringField(record, 'group_id', label)), 'schema'),
    name: stringField(record, 'name', label),
    teamLeadUserId: orReject(
      parseUserId(stringField(record, 'team_lead_user_id', label)),
      'schema',
    ),
    claudeRbacGroupId: orReject(
      parseClaudeRbacGroupId(stringField(record, 'claude_rbac_group_id', label)),
      'schema',
    ),
    gcpProjectId: orReject(
      parseGcpProjectId(stringField(record, 'gcp_project_id', label)),
      'schema',
    ),
    gcpProjectNumber: stringField(record, 'gcp_project_number', label),
    costCentre: stringField(record, 'cost_centre', label),
  };
}

function rowsOf(text: string, key: string): readonly unknown[] {
  const root = asRecord(parseJsonWithLexemes(text).value, 'file');
  return arrayField(root, key, 'file');
}

/**
 * Validates the starter-kit directory exports. Any malformed row or inconsistency rejects
 * the whole directory, so no partial directory can misattribute usage.
 */
export function loadDirectory(usersJson: string, groupsJson: string): Result<Directory, string> {
  try {
    const users: DirectoryUser[] = rowsOf(usersJson, 'users').map(parseUser);
    const groups: DirectoryGroup[] = rowsOf(groupsJson, 'groups').map(parseGroup);
    return buildDirectory(users, groups);
  } catch (error: unknown) {
    if (error instanceof RowStop) {
      return fail(error.message);
    }
    if (error instanceof SyntaxError) {
      return fail(`directory is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}
