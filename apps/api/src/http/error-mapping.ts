import type { Denial, DenialCode } from '../../../../packages/authorization/src/index.js';
import type { JsonValue, ToolErrorCode, ToolOutcome } from '../tool-service.js';

export interface HttpReply {
  readonly status: number;
  readonly body: JsonValue;
}

/** Transport-only failures; domain codes (denials, tool errors) pass through unchanged. */
export const INVALID_REQUEST_BODY = {
  error: 'invalid_input',
  message: 'The request is invalid.',
} as const;
export const INTERNAL_ERROR_BODY = {
  error: 'internal_error',
  message: 'An internal error occurred.',
} as const;
export const NOT_FOUND_BODY = { error: 'not_found', message: 'No such route.' } as const;

function denialStatus(code: DenialCode): number {
  switch (code) {
    case 'identity_unresolved':
      return 401;
    case 'scope_not_granted':
    case 'group_not_permitted':
    case 'group_not_found':
    case 'capability_disabled':
      return 403;
    case 'policy_unavailable':
    case 'capability_state_unavailable':
      return 503;
  }
}

function toolErrorStatus(code: ToolErrorCode): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'no_data':
      return 404;
    case 'data_unavailable':
      return 503;
    case 'unknown_tool':
      // Routes are fixed, so this is a server defect, not a client error.
      return 500;
  }
}

export function denialReply(denial: Denial): HttpReply {
  return { status: denialStatus(denial.code), body: { ...denial } };
}

export function mapOutcome(outcome: ToolOutcome): HttpReply {
  switch (outcome.kind) {
    case 'ok':
      return { status: 200, body: outcome.value };
    case 'denied':
      return denialReply(outcome.denial);
    case 'error':
      return { status: toolErrorStatus(outcome.error.error), body: { ...outcome.error } };
  }
}
