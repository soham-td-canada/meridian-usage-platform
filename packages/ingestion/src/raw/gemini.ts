import { geminiDay, rawIsoWeek } from './calendar.js';
import { decimalToUnits, integerFromLexeme } from './decimal.js';
import type { RawDirectory } from './directory.js';
import { child, labelValue, nonEmptyString, path, type JsonNode } from './lexical-json.js';
import {
  measured,
  UNATTRIBUTED,
  UNDATED,
  UNMEASURABLE,
  type Measure,
  type RawRow,
} from './measures.js';

/** USD has 8 fractional digits in 1e-8 units. */
const USD_SCALE = 8;

function direction(description: string | undefined): 'input' | 'output' | undefined {
  const match = /\b(Input|Output) Tokens\b/.exec(description ?? '');
  return match?.[1] === 'Input' ? 'input' : match?.[1] === 'Output' ? 'output' : undefined;
}

export function rawGeminiRow(node: JsonNode, directory: RawDirectory): RawRow {
  const projectId = nonEmptyString(path(node, 'project', 'id'));
  const day = geminiDay(nonEmptyString(child(node, 'usage_start_time')));
  const amount = path(node, 'usage', 'amount');
  const tokens = amount?.t === 'number' ? integerFromLexeme(amount.lexeme) : undefined;
  const cost = child(node, 'cost');
  const dir = direction(nonEmptyString(path(node, 'sku', 'description')));

  const tokenMeasure = (which: 'input' | 'output'): Measure =>
    dir === undefined ? UNMEASURABLE : which === dir ? measured(tokens) : measured(0n);

  const measures = new Map<string, Measure>([
    ['tokens.input', tokenMeasure('input')],
    ['tokens.output', tokenMeasure('output')],
    ['amount', measured(cost?.t === 'number' ? decimalToUnits(cost.lexeme, USD_SCALE) : undefined)],
  ]);
  return {
    platform: 'gemini',
    group:
      (projectId === undefined ? undefined : directory.groupByProject.get(projectId)) ??
      UNATTRIBUTED,
    day,
    week: day === undefined ? UNDATED : rawIsoWeek(day),
    model: labelValue(child(node, 'labels'), 'model') ?? 'unknown',
    measures,
  };
}
