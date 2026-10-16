import {
  attributeGemini,
  parseEmailAddress,
  parseGcpProjectId,
  parseModelName,
  parseUsdToMoney,
  parseWorkloadName,
  UNAVAILABLE,
  type Directory,
  type GeminiChargeObservation,
  type GeminiUsageObservation,
  type Outcome,
  type SourceRef,
  type TokenDirection,
} from '@meridian/domain';
import { parseJsonWithLexemes, lexemeOf, type ParsedJson } from '../shared/json.js';
import { parseGeminiUtc, usageDay } from '../shared/time.js';
import {
  arrayField,
  asRecord,
  countField,
  field,
  orReject,
  reject,
  runRow,
  stringField,
  unresolved,
  unsupported,
} from '../shared/validate.js';

const SOURCE = 'gemini_billing';

interface SkuSpec {
  readonly model: string;
  readonly modelLabel: string;
  readonly direction: TokenDirection;
  readonly directionLabel: string;
}

/** Explicit, closed SKU map. Direction and model are never inferred from unknown IDs. */
const GEMINI_SKUS: ReadonlyMap<string, SkuSpec> = new Map<string, SkuSpec>([
  [
    'D41E-77B0-2C1A',
    {
      model: 'gemini-2.5-flash',
      modelLabel: 'Flash',
      direction: 'input',
      directionLabel: 'Input',
    },
  ],
  [
    'D41E-77B0-2C1B',
    {
      model: 'gemini-2.5-flash',
      modelLabel: 'Flash',
      direction: 'output',
      directionLabel: 'Output',
    },
  ],
  [
    '8C7B-1A2E-9F03',
    { model: 'gemini-2.5-pro', modelLabel: 'Pro', direction: 'input', directionLabel: 'Input' },
  ],
  [
    '8C7B-1A2E-9F04',
    { model: 'gemini-2.5-pro', modelLabel: 'Pro', direction: 'output', directionLabel: 'Output' },
  ],
]);

/** Price-check arithmetic is exact at 1e-30 USD (scale 30). The tolerance is 1e-6 USD. */
const PRICE_SCALE = 30;
const PRICE_TOLERANCE = 10n ** 24n;
const DECIMAL_LEXEME = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** Diagnostic bounds. A price outside them is reported as unavailable, so BigInt work stays small. */
const PRICE_MAX_LEXEME_LENGTH = 64;
const PRICE_MAX_EXPONENT = 100;
const PRICE_MAX_SHIFT = 200;

export type PriceDiagnostic =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'checked'; readonly deltaUnits: bigint; readonly exceedsTolerance: boolean };

export interface GeminiRowResult {
  readonly usage: GeminiUsageObservation;
  readonly charge: GeminiChargeObservation;
  /** Reported only. It never changes the canonical amount. */
  readonly priceDiagnostic: PriceDiagnostic;
}

/** Converts a JSON number lexeme (plain or exponent form) to an exact count of 10^-scale units. */
function lexemeToScaled(lexeme: string, scale: number): bigint | undefined {
  if (lexeme.length > PRICE_MAX_LEXEME_LENGTH) {
    return undefined;
  }
  const match = DECIMAL_LEXEME.exec(lexeme);
  if (match === null) {
    return undefined;
  }
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (Math.abs(exponent) > PRICE_MAX_EXPONENT) {
    return undefined;
  }
  const shift = exponent - fraction.length + scale;
  if (shift < 0 || shift > PRICE_MAX_SHIFT) {
    return undefined;
  }
  return BigInt(whole + fraction) * 10n ** BigInt(shift);
}

function priceDiagnosticOf(
  priceLexeme: string | undefined,
  usageAmount: number,
  costLexemeUnits: bigint,
): PriceDiagnostic {
  if (priceLexeme === undefined) {
    return { kind: 'unavailable' };
  }
  const priceScaled = lexemeToScaled(priceLexeme, PRICE_SCALE);
  if (priceScaled === undefined) {
    return { kind: 'unavailable' };
  }
  // cost is in 1e-8 USD, so scale it up to 1e-30 USD.
  const costScaled = costLexemeUnits * 10n ** BigInt(PRICE_SCALE - 8);
  const expected = BigInt(usageAmount) * priceScaled;
  const delta = costScaled > expected ? costScaled - expected : expected - costScaled;
  return { kind: 'checked', deltaUnits: delta, exceedsTolerance: delta > PRICE_TOLERANCE };
}

/** Reads a label value from a `[{key, value}]` array. Duplicate keys are ambiguous, so they reject. */
function labelOf(labels: readonly unknown[], key: string, label: string): string | undefined {
  let found: string | undefined;
  for (const entry of labels) {
    const record = asRecord(entry, label);
    if (stringField(record, 'key', label) === key) {
      if (found !== undefined) {
        reject('gemini_label_duplicate', `label "${key}" appears more than once`);
      }
      found = stringField(record, 'value', label);
    }
  }
  return found;
}

function requiredLabel(labels: readonly unknown[], key: string, label: string): string {
  const value = labelOf(labels, key, label);
  if (value === undefined) {
    reject('gemini_label_missing', `${label} is missing label "${key}"`);
  }
  return value;
}

/** Validates one JSONL billing line. Each row yields one usage and one charge, or one outcome. */
export function parseGeminiRow(
  text: string,
  rowIndex: number,
  directory: Directory,
): Outcome<GeminiRowResult> {
  const source: SourceRef = { source: SOURCE, rowIndex };
  return runRow(source, () => {
    let parsed: ParsedJson;
    try {
      parsed = parseJsonWithLexemes(text);
    } catch {
      reject('gemini_json_invalid', 'billing line is not valid JSON');
    }
    const record = asRecord(parsed.value, 'billing row');
    const sku = asRecord(field(record, 'sku', 'row'), 'sku');
    const skuId = stringField(sku, 'id', 'sku');
    const description = stringField(sku, 'description', 'sku');

    const spec = GEMINI_SKUS.get(skuId);
    if (spec === undefined) {
      unsupported('gemini_sku_unknown', `sku "${skuId}" is not in the supported SKU map`);
    }
    if (
      description !==
      `Gemini 2.5 ${spec.modelLabel} Text ${spec.directionLabel} Tokens - Predictions`
    ) {
      reject('gemini_sku_description_mismatch', 'sku description does not match the SKU ID');
    }

    const labels = arrayField(record, 'labels', 'row');
    const modelLabel = requiredLabel(labels, 'model', 'row');
    if (modelLabel !== spec.model) {
      reject('gemini_model_mismatch', 'model label does not match the SKU model');
    }
    const workloadLabel = requiredLabel(labels, 'agent', 'row');
    const ownerLabel = requiredLabel(labels, 'owner', 'row');

    const usage = asRecord(field(record, 'usage', 'row'), 'usage');
    if (stringField(usage, 'unit', 'usage') !== 'count') {
      reject('gemini_unit_invalid', 'usage unit must be "count"');
    }
    const tokens = countField(usage, 'amount', 'usage');

    const startMs = parseGeminiUtc(
      stringField(record, 'usage_start_time', 'row'),
      'usage_start_time',
    );
    const endMs = parseGeminiUtc(stringField(record, 'usage_end_time', 'row'), 'usage_end_time');
    const period = usageDay(startMs, endMs);

    const costLexeme = lexemeOf(parsed, record, 'cost');
    if (costLexeme === undefined) {
      reject('gemini_cost_invalid', 'cost must be a JSON number');
    }
    const costUnits = orReject(parseUsdToMoney(costLexeme), 'gemini_cost_invalid');

    const priceRecord = asRecord(field(record, 'price', 'row'), 'price');
    const priceLexeme = lexemeOf(parsed, priceRecord, 'effective_price');
    const priceDiagnostic = priceDiagnosticOf(priceLexeme, tokens, costUnits);

    if (arrayField(record, 'credits', 'row').length > 0) {
      unsupported('gemini_credits_unsupported', 'non-empty credits are not supported');
    }
    if (field(record, 'adjustment_info', 'row') !== null) {
      unsupported('gemini_adjustment_unsupported', 'non-null adjustment_info is not supported');
    }
    if (stringField(record, 'cost_type', 'row') !== 'regular') {
      unsupported('gemini_cost_type_unsupported', 'cost_type must be "regular"');
    }
    if (stringField(record, 'currency', 'row') !== 'USD') {
      unsupported('gemini_currency_unsupported', 'currency must be "USD"');
    }

    const project = asRecord(field(record, 'project', 'row'), 'project');
    const projectId = orReject(
      parseGcpProjectId(stringField(project, 'id', 'project')),
      'gemini_project_invalid',
    );
    const ownerEmail = orReject(parseEmailAddress(ownerLabel), 'gemini_owner_invalid');
    const teamLabel = requiredLabel(arrayField(project, 'labels', 'project'), 'team', 'project');

    const model = orReject(parseModelName(spec.model), 'gemini_model_invalid');
    const dimensionName = orReject(parseWorkloadName(workloadLabel), 'gemini_workload_invalid');
    const dimension = { kind: 'workload' as const, name: dimensionName };

    const attribution = attributeGemini(directory, { ownerEmail, projectId, teamLabel });
    if (!attribution.ok) {
      unresolved(attribution.error);
    }

    const base = {
      platform: 'gemini' as const,
      userId: attribution.value.userId,
      groupId: attribution.value.groupId,
      period,
      model,
      dimension,
      direction: spec.direction,
    };

    const usageObservation: GeminiUsageObservation = {
      ...base,
      kind: 'usage',
      tokens: { kind: 'known', value: tokens },
      requests: UNAVAILABLE,
      cache: UNAVAILABLE,
      webSearch: UNAVAILABLE,
    };
    const chargeObservation: GeminiChargeObservation = {
      ...base,
      kind: 'charge',
      amount: costUnits,
    };
    return { usage: usageObservation, charge: chargeObservation, priceDiagnostic };
  });
}

/** Parses a whole Gemini JSONL export. Blank trailing lines are ignored. */
export function loadGeminiBilling(text: string, directory: Directory): Outcome<GeminiRowResult>[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line, index) => parseGeminiRow(line.replace(/\r$/, ''), index, directory));
}
