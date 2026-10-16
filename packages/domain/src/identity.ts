import type { Brand } from './brand.js';
import { fail, ok, type Result } from './result.js';

export type UserId = Brand<string, 'UserId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type ClaudeRbacGroupId = Brand<string, 'ClaudeRbacGroupId'>;
export type GcpProjectId = Brand<string, 'GcpProjectId'>;
export type EmailAddress = Brand<string, 'EmailAddress'>;

const MAX_IDENTIFIER_LENGTH = 256;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseIdentifier<Name extends string>(
  name: Name,
  raw: string,
): Result<Brand<string, Name>, string> {
  if (raw.length === 0 || raw.length > MAX_IDENTIFIER_LENGTH || raw !== raw.trim()) {
    return fail(
      `${name} must be a non-empty, trimmed string of at most ${String(MAX_IDENTIFIER_LENGTH)}`,
    );
  }
  return ok(raw as Brand<string, Name>);
}

export const parseUserId = (raw: string): Result<UserId, string> => parseIdentifier('UserId', raw);

export const parseGroupId = (raw: string): Result<GroupId, string> =>
  parseIdentifier('GroupId', raw);

export const parseClaudeRbacGroupId = (raw: string): Result<ClaudeRbacGroupId, string> =>
  parseIdentifier('ClaudeRbacGroupId', raw);

export const parseGcpProjectId = (raw: string): Result<GcpProjectId, string> =>
  parseIdentifier('GcpProjectId', raw);

export function parseEmailAddress(raw: string): Result<EmailAddress, string> {
  if (raw !== raw.trim() || !EMAIL_PATTERN.test(raw)) {
    return fail('EmailAddress must be a trimmed address of the form local@domain');
  }
  return ok(raw as EmailAddress);
}
