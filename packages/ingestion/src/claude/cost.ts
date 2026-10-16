import {
  parseClaudeCentsToMoney,
  type ChargeObservation,
  type ClaudeChargeObservation,
  type Directory,
  type Outcome,
  type SourceRef,
} from '@meridian/domain';
import { orReject, runRow, stringField, unsupported, asRecord } from '../shared/validate.js';
import { attributeClaudeRow, claudeSourceRef, readClaudeRowFields } from './row.js';
import { parseJsonRoot } from './root.js';

const SOURCE = 'claude_cost';

const CHARGE_KINDS = ['tokens', 'web_search'] as const;
type ClaudeChargeKind = (typeof CHARGE_KINDS)[number];

function asChargeKind(raw: string): ClaudeChargeKind {
  const match = CHARGE_KINDS.find((kind) => kind === raw);
  if (match === undefined) {
    unsupported('claude_cost_type_unsupported', `cost_type "${raw}" is not supported`);
  }
  return match;
}

/** Validates one Claude cost row. Charges carry no request counts or directional fields. */
export function parseClaudeCostRow(
  raw: unknown,
  rowIndex: number,
  directory: Directory,
): Outcome<ChargeObservation> {
  const source: SourceRef = claudeSourceRef(SOURCE, rowIndex);
  return runRow(source, () => {
    const record = asRecord(raw, 'cost row');
    const chargeKind = asChargeKind(stringField(record, 'cost_type', 'row'));
    const currency = stringField(record, 'currency', 'row');
    if (currency !== 'USD') {
      unsupported('claude_currency_unsupported', `currency "${currency}" is not supported`);
    }

    const fields = readClaudeRowFields(record);
    const amount = orReject(
      parseClaudeCentsToMoney(stringField(record, 'amount', 'row')),
      'claude_amount_invalid',
    );
    // list_amount is validated with the same rules but is not the canonical charge amount.
    orReject(
      parseClaudeCentsToMoney(stringField(record, 'list_amount', 'row')),
      'claude_list_amount_invalid',
    );

    const attribution = attributeClaudeRow(fields, directory);
    const observation: ClaudeChargeObservation = {
      platform: 'claude',
      kind: 'charge',
      userId: attribution.userId,
      groupId: attribution.groupId,
      period: fields.period,
      model: fields.model,
      dimension: fields.dimension,
      chargeKind,
      amount,
    };
    return observation;
  });
}

/** Parses a whole Claude cost export. File-level structure errors fail the whole file. */
export function loadClaudeCost(
  text: string,
  directory: Directory,
): Outcome<ChargeObservation>[] | string {
  const root = parseJsonRoot(text);
  if (typeof root === 'string') {
    return root;
  }
  return root.data.map((row, index) => parseClaudeCostRow(row, index, directory));
}
