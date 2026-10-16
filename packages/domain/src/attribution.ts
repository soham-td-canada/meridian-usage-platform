import type { Directory } from './directory.js';
import type { ClaudeRbacGroupId, EmailAddress, GcpProjectId, GroupId, UserId } from './identity.js';
import { fail, ok, type Result } from './result.js';

export type UnresolvedReason =
  | { readonly code: 'claude_user_unknown' }
  | { readonly code: 'claude_email_mismatch' }
  | { readonly code: 'claude_group_unknown' }
  | { readonly code: 'claude_group_not_member' }
  | { readonly code: 'gemini_owner_unknown' }
  | { readonly code: 'gemini_project_unknown' }
  | { readonly code: 'gemini_team_label_mismatch' }
  | { readonly code: 'gemini_group_not_member' };

export interface Attribution {
  readonly userId: UserId;
  readonly groupId: GroupId;
}

export interface ClaudeAttributionInput {
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly rbacGroupId: ClaudeRbacGroupId;
}

export interface GeminiAttributionInput {
  readonly ownerEmail: EmailAddress;
  readonly projectId: GcpProjectId;
  readonly teamLabel: string;
}

/** Fails closed: any conflict yields an unresolved reason, never a best guess. */
export function attributeClaude(
  directory: Directory,
  input: ClaudeAttributionInput,
): Result<Attribution, UnresolvedReason> {
  const user = directory.usersById.get(input.userId);
  if (user === undefined) {
    return fail({ code: 'claude_user_unknown' });
  }
  if (user.email !== input.email) {
    return fail({ code: 'claude_email_mismatch' });
  }
  const groupId = directory.groupIdByClaudeRbacGroup.get(input.rbacGroupId);
  if (groupId === undefined) {
    return fail({ code: 'claude_group_unknown' });
  }
  if (!user.groupIds.includes(groupId)) {
    return fail({ code: 'claude_group_not_member' });
  }
  return ok({ userId: user.userId, groupId });
}

/** Fails closed: any conflict yields an unresolved reason, never a best guess. */
export function attributeGemini(
  directory: Directory,
  input: GeminiAttributionInput,
): Result<Attribution, UnresolvedReason> {
  const userId = directory.userIdByEmail.get(input.ownerEmail);
  const user = userId === undefined ? undefined : directory.usersById.get(userId);
  if (user === undefined) {
    return fail({ code: 'gemini_owner_unknown' });
  }
  const groupId = directory.groupIdByGcpProject.get(input.projectId);
  if (groupId === undefined) {
    return fail({ code: 'gemini_project_unknown' });
  }
  if (input.teamLabel !== groupId) {
    return fail({ code: 'gemini_team_label_mismatch' });
  }
  if (!user.groupIds.includes(groupId)) {
    return fail({ code: 'gemini_group_not_member' });
  }
  return ok({ userId: user.userId, groupId });
}
