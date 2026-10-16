import { describe, expect, it } from 'vitest';
import { attributeClaude, attributeGemini } from '../src/attribution.js';
import { buildDirectory, type DirectoryGroup, type DirectoryUser } from '../src/directory.js';
import type {
  ClaudeRbacGroupId,
  EmailAddress,
  GcpProjectId,
  GroupId,
  UserId,
} from '../src/identity.js';
import { parseClaudeCentsToMoney, parseUsdToMoney } from '../src/money.js';

const user = (userId: string, email: string, groupIds: readonly string[]): DirectoryUser => ({
  userId: userId as UserId,
  email: email as EmailAddress,
  name: 'Test',
  role: 'member',
  groupIds: groupIds.map((id) => id as GroupId),
  claudeSeat: true,
  gcpPrincipal: `user:${email}`,
});

const group = (
  groupId: string,
  teamLeadUserId: string,
  rbac?: string,
  project?: string,
): DirectoryGroup => ({
  groupId: groupId as GroupId,
  name: 'Group',
  teamLeadUserId: teamLeadUserId as UserId,
  claudeRbacGroupId: (rbac ?? `rbac_${groupId}`) as ClaudeRbacGroupId,
  gcpProjectId: (project ?? `proj-${groupId}`) as GcpProjectId,
  gcpProjectNumber: '1',
  costCentre: 'CC-1',
});

const baseUsers = [
  user('user_a', 'a@example.test', ['clinical-operations']),
  user('user_b', 'b@example.test', ['finance']),
];
const baseGroups = [group('clinical-operations', 'user_a'), group('finance', 'user_b')];

describe('money parsing (M1, M3)', () => {
  it.each([
    ['88.900050', 88_900_050n],
    ['1.000000', 1_000_000n],
    ['0', 0n],
    ['0.000001', 1n],
  ])('parses cents %s to %s units', (text, units) => {
    expect(parseClaudeCentsToMoney(text)).toEqual({ ok: true, value: units });
  });

  it.each([
    ['1.0000001', 'seven fractional digits'],
    ['-1.000000', 'negative'],
    ['1e-3', 'exponent'],
    ['abc', 'non-numeric'],
    ['', 'empty'],
    ['01.5', 'leading zero'],
    ['1.', 'trailing dot'],
  ])('rejects cents %s (%s)', (text) => {
    expect(parseClaudeCentsToMoney(text).ok).toBe(false);
  });

  it('parses Gemini USD lexemes from raw text (M2)', () => {
    expect(parseUsdToMoney('0.107564')).toEqual({ ok: true, value: 10_756_400n });
  });

  it.each(['0.123456789', '-0.1', '3e-07', 'NaN'])('rejects USD %s', (text) => {
    expect(parseUsdToMoney(text).ok).toBe(false);
  });

  it('rejects an absurdly long numeric string without converting it to BigInt', () => {
    const text = `${'9'.repeat(1_000_000)}.${'0'.repeat(6)}`;
    expect(parseClaudeCentsToMoney(text).ok).toBe(false);
    expect(parseUsdToMoney(text).ok).toBe(false);
  });
});

describe('directory validation (D1)', () => {
  it('accepts a consistent directory', () => {
    expect(buildDirectory(baseUsers, baseGroups).ok).toBe(true);
  });

  it('rejects duplicate user_id', () => {
    const users = [...baseUsers, user('user_a', 'c@example.test', [])];
    expect(buildDirectory(users, baseGroups).ok).toBe(false);
  });

  it('rejects duplicate email', () => {
    const users = [...baseUsers, user('user_c', 'a@example.test', [])];
    expect(buildDirectory(users, baseGroups).ok).toBe(false);
  });

  it('rejects duplicate group_id', () => {
    expect(buildDirectory(baseUsers, [...baseGroups, group('finance', 'user_b')]).ok).toBe(false);
  });

  it('rejects duplicate claude_rbac_group_id', () => {
    const groups = [...baseGroups, group('hr', 'user_b', 'rbac_finance')];
    expect(buildDirectory(baseUsers, groups).ok).toBe(false);
  });

  it('rejects duplicate gcp_project_id', () => {
    const groups = [...baseGroups, group('hr', 'user_b', undefined, 'proj-finance')];
    expect(buildDirectory(baseUsers, groups).ok).toBe(false);
  });

  it('rejects an unknown team_lead_user_id', () => {
    expect(buildDirectory(baseUsers, [group('hr', 'user_missing')]).ok).toBe(false);
  });

  it('rejects an unknown group in group_ids', () => {
    const users = [user('user_a', 'a@example.test', ['nope'])];
    expect(buildDirectory(users, baseGroups).ok).toBe(false);
  });
});

describe('attribution conflicts (A3, A4)', () => {
  const built = buildDirectory(baseUsers, baseGroups);
  if (!built.ok) {
    throw new Error(built.error);
  }
  const directory = built.value;

  it('resolves a consistent Claude row (A1 shape)', () => {
    const result = attributeClaude(directory, {
      userId: 'user_a' as UserId,
      email: 'a@example.test' as EmailAddress,
      rbacGroupId: 'rbac_clinical-operations' as ClaudeRbacGroupId,
    });
    expect(result).toEqual({
      ok: true,
      value: { userId: 'user_a', groupId: 'clinical-operations' },
    });
  });

  it.each([
    [
      'user_id/email mismatch',
      'user_a',
      'b@example.test',
      'rbac_clinical-operations',
      'claude_email_mismatch',
    ],
    ['unknown rbac group', 'user_a', 'a@example.test', 'rbac_nope', 'claude_group_unknown'],
    [
      'group not in group_ids',
      'user_a',
      'a@example.test',
      'rbac_finance',
      'claude_group_not_member',
    ],
    [
      'unknown user_id',
      'user_zzz',
      'a@example.test',
      'rbac_clinical-operations',
      'claude_user_unknown',
    ],
  ])('Claude conflict: %s', (_label, userId, email, rbac, code) => {
    const result = attributeClaude(directory, {
      userId: userId as UserId,
      email: email as EmailAddress,
      rbacGroupId: rbac as ClaudeRbacGroupId,
    });
    expect(result).toEqual({ ok: false, error: { code } });
  });

  it('resolves a consistent Gemini row (A2 shape)', () => {
    const result = attributeGemini(directory, {
      ownerEmail: 'a@example.test' as EmailAddress,
      projectId: 'proj-clinical-operations' as GcpProjectId,
      teamLabel: 'clinical-operations',
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      'unknown owner',
      'x@example.test',
      'proj-clinical-operations',
      'clinical-operations',
      'gemini_owner_unknown',
    ],
    [
      'unknown project',
      'a@example.test',
      'proj-nope',
      'clinical-operations',
      'gemini_project_unknown',
    ],
    [
      'team label mismatch',
      'a@example.test',
      'proj-clinical-operations',
      'finance',
      'gemini_team_label_mismatch',
    ],
    [
      'owner not in group',
      'b@example.test',
      'proj-clinical-operations',
      'clinical-operations',
      'gemini_group_not_member',
    ],
  ])('Gemini conflict: %s', (_label, owner, project, team, code) => {
    const result = attributeGemini(directory, {
      ownerEmail: owner as EmailAddress,
      projectId: project as GcpProjectId,
      teamLabel: team,
    });
    expect(result).toEqual({ ok: false, error: { code } });
  });
});
