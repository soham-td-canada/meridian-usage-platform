import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDirectory } from '../src/directory/adapter.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../starter-kit/data/directory/${name}`, import.meta.url), 'utf8');

const usersJson = fixture('users.json');
const groupsJson = fixture('groups.json');

describe('directory fixtures (D1 positive)', () => {
  it('loads the starter-kit directory', () => {
    const result = loadDirectory(usersJson, groupsJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.usersById.size).toBe(22);
      expect(result.value.groupsById.size).toBe(6);
    }
  });
});

describe('directory rejection (D1)', () => {
  const parsedUsers = JSON.parse(usersJson) as { users: Record<string, unknown>[] };
  const parsedGroups = JSON.parse(groupsJson) as { groups: Record<string, unknown>[] };

  const withUsers = (users: unknown[]): string => JSON.stringify({ ...parsedUsers, users });
  const withGroups = (groups: unknown[]): string => JSON.stringify({ ...parsedGroups, groups });

  it('rejects a duplicate user_id', () => {
    const [first, second, ...rest] = parsedUsers.users;
    const dup = { ...second, user_id: first?.['user_id'] };
    expect(loadDirectory(withUsers([first, dup, ...rest]), groupsJson).ok).toBe(false);
  });

  it('rejects a duplicate email', () => {
    const [first, second, ...rest] = parsedUsers.users;
    const dup = { ...second, email: first?.['email'] };
    expect(loadDirectory(withUsers([first, dup, ...rest]), groupsJson).ok).toBe(false);
  });

  it('rejects a duplicate group_id', () => {
    const [first, second, ...rest] = parsedGroups.groups;
    const dup = { ...second, group_id: first?.['group_id'] };
    expect(loadDirectory(usersJson, withGroups([first, dup, ...rest])).ok).toBe(false);
  });

  it('rejects a duplicate claude_rbac_group_id', () => {
    const [first, second, ...rest] = parsedGroups.groups;
    const dup = { ...second, claude_rbac_group_id: first?.['claude_rbac_group_id'] };
    expect(loadDirectory(usersJson, withGroups([first, dup, ...rest])).ok).toBe(false);
  });

  it('rejects a duplicate gcp_project_id', () => {
    const [first, second, ...rest] = parsedGroups.groups;
    const dup = { ...second, gcp_project_id: first?.['gcp_project_id'] };
    expect(loadDirectory(usersJson, withGroups([first, dup, ...rest])).ok).toBe(false);
  });

  it('rejects an unknown team_lead_user_id', () => {
    const [first, ...rest] = parsedGroups.groups;
    const bad = { ...first, team_lead_user_id: 'user_missing' };
    expect(loadDirectory(usersJson, withGroups([bad, ...rest])).ok).toBe(false);
  });

  it('rejects an unknown group in group_ids', () => {
    const [first, ...rest] = parsedUsers.users;
    const bad = { ...first, group_ids: ['not-a-group'] };
    expect(loadDirectory(withUsers([bad, ...rest]), groupsJson).ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    const [first, ...rest] = parsedUsers.users;
    const bad = { ...first, role: 'superadmin' };
    expect(loadDirectory(withUsers([bad, ...rest]), groupsJson).ok).toBe(false);
  });

  it('rejects a malformed file', () => {
    expect(loadDirectory('{not json', groupsJson).ok).toBe(false);
  });
});
