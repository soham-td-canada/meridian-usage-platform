import { claudeDay, rawIsoWeek } from './calendar.js';
import { decimalToUnits, integerFromLexeme } from './decimal.js';
import type { RawDirectory } from './directory.js';
import { child, nonEmptyString, path, type JsonNode } from './lexical-json.js';
import {
  measured,
  UNATTRIBUTED,
  UNDATED,
  type Measure,
  type RawClaudePairing,
  type RawRow,
} from './measures.js';

/** 1 cent = 1e6 units of 1e-8 USD. */
const CENTS_SCALE = 6;

function count(node: JsonNode | undefined): bigint | undefined {
  return node?.t === 'number' ? integerFromLexeme(node.lexeme) : undefined;
}

function cents(node: JsonNode | undefined): bigint | undefined {
  return node?.t === 'string' ? decimalToUnits(node.v, CENTS_SCALE) : undefined;
}

function pairing(node: JsonNode, costType: string | undefined): RawClaudePairing {
  const userId = nonEmptyString(path(node, 'actor', 'user_id'));
  const startingAt = nonEmptyString(child(node, 'starting_at'));
  const product = nonEmptyString(child(node, 'product'));
  const model = nonEmptyString(child(node, 'model'));
  const requests = child(node, 'requests');
  const webSearch = count(path(node, 'server_tool_use', 'web_search_requests'));
  return {
    pairKey:
      userId === undefined ||
      startingAt === undefined ||
      product === undefined ||
      model === undefined
        ? undefined
        : JSON.stringify([userId, startingAt, product, model]),
    costType,
    requests: requests?.t === 'number' ? requests.lexeme : undefined,
    rbacGroupId: nonEmptyString(child(node, 'rbac_group_id')),
    email: nonEmptyString(path(node, 'actor', 'email')),
    webSearchRequests: webSearch,
  };
}

function placement(
  node: JsonNode,
  directory: RawDirectory,
): { group: string; day: string | undefined; week: string; model: string } {
  const rbac = nonEmptyString(child(node, 'rbac_group_id'));
  const day = claudeDay(nonEmptyString(child(node, 'starting_at')));
  return {
    group: (rbac === undefined ? undefined : directory.groupByRbac.get(rbac)) ?? UNATTRIBUTED,
    day,
    week: day === undefined ? UNDATED : rawIsoWeek(day),
    model: nonEmptyString(child(node, 'model')) ?? 'unknown',
  };
}

export function rawClaudeUsage(node: JsonNode, directory: RawDirectory): RawRow {
  const uncached = count(child(node, 'uncached_input_tokens'));
  const cacheRead = count(child(node, 'cache_read_input_tokens'));
  const cache5m = count(path(node, 'cache_creation', 'ephemeral_5m_input_tokens'));
  const cache1h = count(path(node, 'cache_creation', 'ephemeral_1h_input_tokens'));
  const output = count(child(node, 'output_tokens'));
  let inputTotal: bigint | undefined = 0n;
  for (const part of [uncached, cacheRead, cache5m, cache1h]) {
    inputTotal = part === undefined || inputTotal === undefined ? undefined : inputTotal + part;
  }
  const measures = new Map<string, Measure>([
    ['uncachedInput', measured(uncached)],
    ['cacheReadInput', measured(cacheRead)],
    ['cacheCreation5mInput', measured(cache5m)],
    ['cacheCreation1hInput', measured(cache1h)],
    ['output', measured(output)],
    ['inputTotal', measured(inputTotal)],
    ['totalTokens', measured(count(child(node, 'total_tokens')))],
    ['requests', measured(count(child(node, 'requests')))],
    ['webSearchRequests', measured(count(path(node, 'server_tool_use', 'web_search_requests')))],
  ]);
  return {
    platform: 'claude',
    ...placement(node, directory),
    measures,
    claudePairing: pairing(node, undefined),
  };
}

export function rawClaudeCost(node: JsonNode, directory: RawDirectory): RawRow {
  return {
    platform: 'claude',
    ...placement(node, directory),
    measures: new Map<string, Measure>([['amount', measured(cents(child(node, 'amount')))]]),
    claudePairing: pairing(node, nonEmptyString(child(node, 'cost_type'))),
  };
}
