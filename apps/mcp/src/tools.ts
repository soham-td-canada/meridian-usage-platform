import { CAPABILITIES } from '../../../packages/domain/src/index.js';
import {
  DEFAULT_TOP_USERS_LIMIT,
  MAX_TOP_USERS_LIMIT,
  type JsonValue,
  type ToolName,
} from '../../api/src/index.js';

export const GROUP_IDS = [
  'clinical-operations',
  'regulatory-affairs',
  'finance',
  'hr',
  'medical-writing',
  'it-platform',
] as const;

export const PERIOD_PATTERN = '^(last_7_days|last_30_days|\\d{4}-W\\d{2}|\\d{4}-\\d{2})$';

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

const group = { type: 'string', enum: [...GROUP_IDS] } as const;
const period = { type: 'string', pattern: PERIOD_PATTERN } as const;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'usage_summary',
    description:
      "Per-platform tokens and cost for a group over a period. Defaults to the caller's own group.",
    inputSchema: {
      type: 'object',
      properties: { group, period },
      required: ['period'],
      additionalProperties: false,
    },
  },
  {
    name: 'top_users',
    description:
      "Users ranked by total tokens for a group over a period. Defaults to the caller's own group.",
    inputSchema: {
      type: 'object',
      properties: {
        group,
        period,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TOP_USERS_LIMIT,
          default: DEFAULT_TOP_USERS_LIMIT,
        },
      },
      required: ['period'],
      additionalProperties: false,
    },
  },
  {
    name: 'capability_status',
    description:
      "Enable/disable state of each capability for a group. Defaults to the caller's own group.",
    inputSchema: { type: 'object', properties: { group }, additionalProperties: false },
  },
  {
    name: 'set_capability',
    description: 'Enable or disable a capability for a group.',
    inputSchema: {
      type: 'object',
      properties: {
        group,
        capability: { type: 'string', enum: [...CAPABILITIES] },
        enabled: { type: 'boolean' },
      },
      required: ['group', 'capability', 'enabled'],
      additionalProperties: false,
    },
  },
];
