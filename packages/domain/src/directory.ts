import type { ClaudeRbacGroupId, EmailAddress, GcpProjectId, GroupId, UserId } from './identity.js';
import { fail, ok, type Result } from './result.js';

export type UserRole = 'member' | 'team_lead' | 'platform_admin';

export interface DirectoryUser {
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly name: string;
  readonly role: UserRole;
  readonly groupIds: readonly GroupId[];
  readonly claudeSeat: boolean;
  readonly gcpPrincipal: string;
}

export interface DirectoryGroup {
  readonly groupId: GroupId;
  readonly name: string;
  readonly teamLeadUserId: UserId;
  readonly claudeRbacGroupId: ClaudeRbacGroupId;
  readonly gcpProjectId: GcpProjectId;
  readonly gcpProjectNumber: string;
  readonly costCentre: string;
}

export interface Directory {
  readonly usersById: ReadonlyMap<UserId, DirectoryUser>;
  readonly userIdByEmail: ReadonlyMap<EmailAddress, UserId>;
  readonly groupsById: ReadonlyMap<GroupId, DirectoryGroup>;
  readonly groupIdByClaudeRbacGroup: ReadonlyMap<ClaudeRbacGroupId, GroupId>;
  readonly groupIdByGcpProject: ReadonlyMap<GcpProjectId, GroupId>;
}

/**
 * Builds an indexed directory. The whole directory is rejected on any inconsistency,
 * because a partially valid directory could mis-attribute usage.
 */
export function buildDirectory(
  users: readonly DirectoryUser[],
  groups: readonly DirectoryGroup[],
): Result<Directory, string> {
  const usersById = new Map<UserId, DirectoryUser>();
  const userIdByEmail = new Map<EmailAddress, UserId>();
  for (const user of users) {
    if (usersById.has(user.userId)) {
      return fail(`duplicate user_id ${user.userId}`);
    }
    if (userIdByEmail.has(user.email)) {
      return fail(`duplicate email ${user.email}`);
    }
    usersById.set(user.userId, user);
    userIdByEmail.set(user.email, user.userId);
  }

  const groupsById = new Map<GroupId, DirectoryGroup>();
  const groupIdByClaudeRbacGroup = new Map<ClaudeRbacGroupId, GroupId>();
  const groupIdByGcpProject = new Map<GcpProjectId, GroupId>();
  for (const group of groups) {
    if (groupsById.has(group.groupId)) {
      return fail(`duplicate group_id ${group.groupId}`);
    }
    if (groupIdByClaudeRbacGroup.has(group.claudeRbacGroupId)) {
      return fail(`duplicate claude_rbac_group_id ${group.claudeRbacGroupId}`);
    }
    if (groupIdByGcpProject.has(group.gcpProjectId)) {
      return fail(`duplicate gcp_project_id ${group.gcpProjectId}`);
    }
    if (!usersById.has(group.teamLeadUserId)) {
      return fail(`unknown team_lead_user_id ${group.teamLeadUserId} in group ${group.groupId}`);
    }
    groupsById.set(group.groupId, group);
    groupIdByClaudeRbacGroup.set(group.claudeRbacGroupId, group.groupId);
    groupIdByGcpProject.set(group.gcpProjectId, group.groupId);
  }

  for (const user of users) {
    for (const groupId of user.groupIds) {
      if (!groupsById.has(groupId)) {
        return fail(`user ${user.userId} references unknown group ${groupId}`);
      }
    }
  }

  return ok({
    usersById,
    userIdByEmail,
    groupsById,
    groupIdByClaudeRbacGroup,
    groupIdByGcpProject,
  });
}
