import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Directory, Outcome, UsageObservation } from '@meridian/domain';
import { loadDirectory } from '../src/directory/adapter.js';
import { parseClaudeCostRow } from '../src/claude/cost.js';
import { parseClaudeUsageRow } from '../src/claude/usage.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../starter-kit/data/${name}`, import.meta.url), 'utf8');

const loaded = loadDirectory(fixture('directory/users.json'), fixture('directory/groups.json'));
if (!loaded.ok) {
  throw new Error(`fixture directory failed to load: ${loaded.error}`);
}
const directory: Directory = loaded.value;

const usageRows = (JSON.parse(fixture('claude/user_usage_report.json')) as { data: unknown[] })
  .data;
const costRows = (JSON.parse(fixture('claude/user_cost_report.json')) as { data: unknown[] }).data;

type Row = Record<string, unknown>;
const clone = (row: unknown): Row => JSON.parse(JSON.stringify(row)) as Row;

/** Returns the first usage row, mutated by `edit`. */
const usageWith = (edit: (row: Row) => void): unknown => {
  const row = clone(usageRows[0]);
  edit(row);
  return row;
};
const costWith = (edit: (row: Row) => void): unknown => {
  const row = clone(costRows[0]);
  edit(row);
  return row;
};

const parseUsage = (raw: unknown): Outcome<UsageObservation> =>
  parseClaudeUsageRow(raw, 0, directory);

const expectRejected = (outcome: Outcome<unknown>): void => {
  expect(outcome.kind).toBe('rejected');
};

/** A group that the given user is NOT a member of, so the attribution must fail closed. */
const nonMemberRbacGroup = (userId: string): string => {
  const user = directory.usersById.get(userId as never);
  if (user === undefined) {
    throw new Error('test user missing from directory');
  }
  const group = [...directory.groupsById.values()].find(
    (candidate) => !user.groupIds.includes(candidate.groupId),
  );
  if (group === undefined) {
    throw new Error('no non-member group available');
  }
  return group.claudeRbacGroupId;
};

describe('Claude usage: canonical tokens (C1, C4)', () => {
  it('maps the C1 fixture row to canonical input and output totals', () => {
    const outcome = parseUsage(usageRows[0]);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    const obs = outcome.value;
    expect(obs.platform).toBe('claude');
    if (obs.platform !== 'claude') return;
    expect(obs.period).toBe('2026-08-03');
    expect(obs.userId).toBe('user_E7691888F28227066DD2FB86');
    expect(obs.groupId).toBe('clinical-operations');
    expect(obs.uncachedInput).toBe(14562);
    expect(obs.cacheReadInput).toBe(31297);
    expect(obs.cacheCreation5mInput).toBe(3516);
    expect(obs.cacheCreation1hInput).toBe(1175);
    expect(obs.output).toBe(6966);
    expect(obs.inputTotal).toBe(50550);
    expect(obs.requests).toEqual({ kind: 'known', value: 7 });
    expect(obs.webSearchRequests).toEqual({ kind: 'known', value: 1 });
  });

  it('treats web_search_requests of 0 as a known zero, not as missing', () => {
    const outcome = parseUsage(
      usageWith((row) => (row['server_tool_use'] = { web_search_requests: 0 })),
    );
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved' && outcome.value.platform === 'claude') {
      expect(outcome.value.webSearchRequests).toEqual({ kind: 'known', value: 0 });
    }
  });
});

describe('Claude usage validation (V1)', () => {
  it('rejects a missing cache_creation object', () => {
    expectRejected(parseUsage(usageWith((row) => delete row['cache_creation'])));
  });

  it('rejects a negative token count', () => {
    expectRejected(parseUsage(usageWith((row) => (row['output_tokens'] = -1))));
  });

  it('rejects a non-integer token count', () => {
    expectRejected(parseUsage(usageWith((row) => (row['output_tokens'] = 1.5))));
  });

  it('rejects total_tokens that differs from the sum of token fields', () => {
    expectRejected(parseUsage(usageWith((row) => (row['total_tokens'] = 1))));
  });

  it('rejects a missing web_search_requests field', () => {
    expectRejected(parseUsage(usageWith((row) => (row['server_tool_use'] = {}))));
  });

  it('rejects a period that is not exactly 24 hours', () => {
    expectRejected(parseUsage(usageWith((row) => (row['ending_at'] = '2026-08-03T12:00:00.000Z'))));
  });

  it('rejects a malformed timestamp', () => {
    expectRejected(parseUsage(usageWith((row) => (row['starting_at'] = '2026-08-03'))));
  });
});

describe('Claude dimensions (V3)', () => {
  const withProduct = (product: string): Outcome<UsageObservation> =>
    parseUsage(usageWith((row) => (row['product'] = product)));

  it('preserves a new valid product and model string', () => {
    const outcome = withProduct('cowork_v2');
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved' && outcome.value.platform === 'claude') {
      expect(outcome.value.dimension).toEqual({ kind: 'product', name: 'cowork_v2' });
    }
  });

  it('accepts a future model name', () => {
    const outcome = parseUsage(usageWith((row) => (row['model'] = 'claude-future-model-1')));
    expect(outcome.kind).toBe('resolved');
  });

  it.each([
    ['empty', ''],
    ['whitespace padded', ' chat'],
    ['trailing whitespace', 'chat '],
  ])('rejects a product that is %s', (_label, product) => {
    expectRejected(withProduct(product));
  });

  it.each(['a'.repeat(65), 'chat!'])('accepts an open product value %s', (product) => {
    const outcome = withProduct(product);
    expect(outcome.kind).toBe('resolved');
  });

  it('rejects a malformed product even when the user is unknown, before attribution runs', () => {
    const outcome = parseUsage(
      usageWith((row) => {
        row['product'] = '';
        (row['actor'] as Row)['user_id'] = 'user_UNKNOWN';
      }),
    );
    expectRejected(outcome);
  });
});

describe('Claude attribution (A1, A3)', () => {
  it('resolves the C1 row to the expected user and group', () => {
    expect(parseUsage(usageRows[0]).kind).toBe('resolved');
  });

  it('is unresolved when user_id is unknown', () => {
    const outcome = parseUsage(
      usageWith((row) => {
        (row['actor'] as Row)['user_id'] = 'user_UNKNOWN';
      }),
    );
    expect(outcome).toMatchObject({ kind: 'unresolved', reason: { code: 'claude_user_unknown' } });
  });

  it('is unresolved when the email does not match user_id', () => {
    const outcome = parseUsage(
      usageWith((row) => {
        (row['actor'] as Row)['email'] = 'someone.else@meridianls.example';
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: { code: 'claude_email_mismatch' },
    });
  });

  it('is unresolved when rbac_group_id is unknown', () => {
    const outcome = parseUsage(usageWith((row) => (row['rbac_group_id'] = 'rbac_group_UNKNOWN')));
    expect(outcome).toMatchObject({ kind: 'unresolved', reason: { code: 'claude_group_unknown' } });
  });

  it('is unresolved when the group is not in the user group_ids', () => {
    const userId = (usageRows[0] as { actor: { user_id: string } }).actor.user_id;
    const outcome = parseUsage(
      usageWith((row) => (row['rbac_group_id'] = nonMemberRbacGroup(userId))),
    );
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: { code: 'claude_group_not_member' },
    });
  });
});

describe('Claude cost charges (M1, C2, C3, U1, U2)', () => {
  it('parses the fixture cents string exactly', () => {
    const outcome = parseClaudeCostRow(costRows[0], 0, directory);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved' && outcome.value.platform === 'claude') {
      expect(outcome.value.amount).toBe(88900050n);
      expect(outcome.value.chargeKind).toBe('tokens');
      expect(outcome.value).not.toHaveProperty('requests');
    }
  });

  it('parses "1.000000" cents as 1000000n', () => {
    const outcome = parseClaudeCostRow(
      costWith((row) => (row['amount'] = '1.000000')),
      0,
      directory,
    );
    expect(outcome.kind === 'resolved' && outcome.value.amount === 1000000n).toBe(true);
  });

  it('rejects cents with more than six fractional digits', () => {
    expectRejected(
      parseClaudeCostRow(
        costWith((row) => (row['amount'] = '1.0000001')),
        0,
        directory,
      ),
    );
  });

  it('rejects an exponent amount', () => {
    expectRejected(
      parseClaudeCostRow(
        costWith((row) => (row['amount'] = '1e3')),
        0,
        directory,
      ),
    );
  });

  it('keeps amount as the canonical charge even when list_amount differs', () => {
    const outcome = parseClaudeCostRow(
      costWith((row) => {
        row['amount'] = '1.000000';
        row['list_amount'] = '2.500000';
      }),
      0,
      directory,
    );
    expect(outcome.kind === 'resolved' && outcome.value.amount).toBe(1000000n);
  });

  it.each([
    ['exponent', '1e3'],
    ['over six fractional digits', '1.0000001'],
    ['non-numeric', 'abc'],
  ])('rejects an invalid list_amount (%s)', (_label, listAmount) => {
    expectRejected(
      parseClaudeCostRow(
        costWith((row) => (row['list_amount'] = listAmount)),
        0,
        directory,
      ),
    );
  });

  it('marks an unknown cost_type unsupported', () => {
    const outcome = parseClaudeCostRow(
      costWith((row) => (row['cost_type'] = 'other')),
      0,
      directory,
    );
    expect(outcome.kind).toBe('unsupported');
  });

  it('marks a non-USD currency unsupported', () => {
    const outcome = parseClaudeCostRow(
      costWith((row) => (row['currency'] = 'EUR')),
      0,
      directory,
    );
    expect(outcome.kind).toBe('unsupported');
  });

  it('keeps web_search as a distinct charge kind', () => {
    const webSearch = costRows.find((row) => (row as Row)['cost_type'] === 'web_search');
    expect(webSearch).toBeDefined();
    const outcome = parseClaudeCostRow(webSearch, 0, directory);
    expect(
      outcome.kind === 'resolved' &&
        outcome.value.platform === 'claude' &&
        outcome.value.chargeKind,
    ).toBe('web_search');
  });
});

describe('Claude time (T1)', () => {
  it('assigns starting_at 2026-08-04T00:00:00Z to 2026-08-04', () => {
    const outcome = parseUsage(
      usageWith((row) => {
        row['starting_at'] = '2026-08-04T00:00:00.000Z';
        row['ending_at'] = '2026-08-05T00:00:00.000Z';
      }),
    );
    expect(outcome.kind === 'resolved' && outcome.value.period).toBe('2026-08-04');
  });
});
