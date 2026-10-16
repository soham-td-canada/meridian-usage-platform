import {
  attributeClaude,
  parseClaudeRbacGroupId,
  parseEmailAddress,
  parseModelName,
  parseProductName,
  parseUserId,
  type Attribution,
  type ClaudeRbacGroupId,
  type Directory,
  type Dimension,
  type EmailAddress,
  type ModelName,
  type SourceName,
  type SourceRef,
  type UserId,
  type UtcDay,
} from '@meridian/domain';
import { parseRfc3339Utc, usageDay } from '../shared/time.js';
import {
  asRecord,
  field,
  orReject,
  stringField,
  unresolved,
  type JsonRecord,
} from '../shared/validate.js';

export interface ClaudeRowIdentity {
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly rbacGroupId: ClaudeRbacGroupId;
}

/** Shape-validated fields shared by Claude usage and cost rows. Not yet attributed. */
export interface ClaudeRowFields {
  readonly identity: ClaudeRowIdentity;
  readonly dimension: Extract<Dimension, { kind: 'product' }>;
  readonly model: ModelName;
  readonly period: UtcDay;
}

export function claudeSourceRef(source: SourceName, rowIndex: number): SourceRef {
  return { source, rowIndex };
}

/** Validates every row field except attribution. Malformed rows are rejected here, before attribution. */
export function readClaudeRowFields(record: JsonRecord): ClaudeRowFields {
  const actor = asRecord(field(record, 'actor', 'row'), 'actor');
  const userId = orReject(
    parseUserId(stringField(actor, 'user_id', 'actor')),
    'claude_user_id_invalid',
  );
  const email = orReject(
    parseEmailAddress(stringField(actor, 'email', 'actor')),
    'claude_email_invalid',
  );
  const rbacGroupId = orReject(
    parseClaudeRbacGroupId(stringField(record, 'rbac_group_id', 'row')),
    'claude_rbac_group_invalid',
  );
  const product = orReject(
    parseProductName(stringField(record, 'product', 'row')),
    'claude_product_invalid',
  );
  const model = orReject(
    parseModelName(stringField(record, 'model', 'row')),
    'claude_model_invalid',
  );

  const startMs = parseRfc3339Utc(stringField(record, 'starting_at', 'row'), 'starting_at');
  const endMs = parseRfc3339Utc(stringField(record, 'ending_at', 'row'), 'ending_at');

  return {
    identity: { userId, email, rbacGroupId },
    dimension: { kind: 'product', name: product },
    model,
    period: usageDay(startMs, endMs),
  };
}

/** Attributes a fully validated row. Conflicts or unknown identities stop the row as unresolved. */
export function attributeClaudeRow(fields: ClaudeRowFields, directory: Directory): Attribution {
  const attribution = attributeClaude(directory, fields.identity);
  if (!attribution.ok) {
    unresolved(attribution.error);
  }
  return attribution.value;
}
