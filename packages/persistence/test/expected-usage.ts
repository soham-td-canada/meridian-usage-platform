import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Independent oracle: recomputes expected totals straight from the starter-kit files. */

type Json = Readonly<Record<string, unknown>>;

const DATA = join(process.cwd(), 'starter-kit/data');

function parsed(path: string, key: string): readonly Json[] {
  const document: unknown = JSON.parse(read(path));
  return records((document as Json)[key]);
}

function read(path: string): string {
  return readFileSync(join(DATA, path), 'utf8');
}

function records(value: unknown): readonly Json[] {
  if (!Array.isArray(value)) {
    throw new Error('expected array');
  }
  return value.filter((item): item is Json => typeof item === 'object' && item !== null);
}

function str(row: Json, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function int(value: unknown): bigint {
  if (typeof value !== 'number') {
    throw new Error('expected number');
  }
  return BigInt(value);
}

function nested(row: Json, key: string): Json {
  const value = row[key];
  if (typeof value !== 'object' || value === null) {
    throw new Error(`missing ${key}`);
  }
  return value as Json;
}

/** Claude cents decimal string (six fractional digits) to 1e-8 USD units. */
function centsToE8(text: string): bigint {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(6, '0'));
}

export interface ExpectedUsage {
  claudeInput: bigint;
  claudeOutput: bigint;
  claudeRequests: bigint;
  claudeCostE8: bigint;
  geminiInput: bigint;
  geminiOutput: bigint;
  geminiCostE8: bigint;
  users: Map<string, { tokens: bigint; costE8: bigint }>;
}

export function expectedUsage(groupId: string, start: string, endExclusive: string): ExpectedUsage {
  const groups = parsed('directory/groups.json', 'groups');
  const users = parsed('directory/users.json', 'users');
  const group = groups.find((candidate) => str(candidate, 'group_id') === groupId);
  if (group === undefined) {
    throw new Error('unknown group');
  }
  const rbac = str(group, 'claude_rbac_group_id');
  const project = str(group, 'gcp_project_id');
  const idByEmail = new Map(users.map((user) => [str(user, 'email'), str(user, 'user_id')]));
  const inWindow = (day: string): boolean => day >= start && day < endExclusive;

  const result: ExpectedUsage = {
    claudeInput: 0n,
    claudeOutput: 0n,
    claudeRequests: 0n,
    claudeCostE8: 0n,
    geminiInput: 0n,
    geminiOutput: 0n,
    geminiCostE8: 0n,
    users: new Map(),
  };
  const bump = (userId: string, tokens: bigint, costE8: bigint): void => {
    const current = result.users.get(userId) ?? { tokens: 0n, costE8: 0n };
    result.users.set(userId, { tokens: current.tokens + tokens, costE8: current.costE8 + costE8 });
  };

  const usage = parsed('claude/user_usage_report.json', 'data');
  for (const row of usage) {
    if (str(row, 'rbac_group_id') !== rbac || !inWindow(str(row, 'starting_at').slice(0, 10))) {
      continue;
    }
    const cache = nested(row, 'cache_creation');
    const input =
      int(row['uncached_input_tokens']) +
      int(row['cache_read_input_tokens']) +
      int(cache['ephemeral_5m_input_tokens']) +
      int(cache['ephemeral_1h_input_tokens']);
    const output = int(row['output_tokens']);
    result.claudeInput += input;
    result.claudeOutput += output;
    result.claudeRequests += int(row['requests']);
    bump(str(nested(row, 'actor'), 'user_id'), input + output, 0n);
  }
  const cost = parsed('claude/user_cost_report.json', 'data');
  for (const row of cost) {
    if (str(row, 'rbac_group_id') !== rbac || !inWindow(str(row, 'starting_at').slice(0, 10))) {
      continue;
    }
    const amount = centsToE8(str(row, 'amount'));
    result.claudeCostE8 += amount;
    bump(str(nested(row, 'actor'), 'user_id'), 0n, amount);
  }
  for (const line of read('gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl')
    .split('\n')
    .filter((candidate) => candidate !== '')) {
    const row = JSON.parse(line) as Json;
    if (
      str(nested(row, 'project'), 'id') !== project ||
      !inWindow(str(row, 'usage_start_time').slice(0, 10))
    ) {
      continue;
    }
    const tokens = int(nested(row, 'usage')['amount']);
    const amount = BigInt(Math.round(Number(row['cost']) * 1e8));
    if (str(nested(row, 'sku'), 'description').includes('Input Tokens')) {
      result.geminiInput += tokens;
    } else {
      result.geminiOutput += tokens;
    }
    result.geminiCostE8 += amount;
    const owner = (row['labels'] as readonly Json[]).find((label) => label['key'] === 'owner');
    const userId = idByEmail.get(String(owner?.['value']));
    if (userId === undefined) {
      throw new Error('unknown owner');
    }
    bump(userId, tokens, amount);
  }
  return result;
}
