import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Directory, Outcome } from '@meridian/domain';
import { loadDirectory } from '../src/directory/adapter.js';
import { parseGeminiRow, type GeminiRowResult } from '../src/gemini/billing.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../starter-kit/data/${name}`, import.meta.url), 'utf8');

const loaded = loadDirectory(fixture('directory/users.json'), fixture('directory/groups.json'));
if (!loaded.ok) {
  throw new Error(`fixture directory failed to load: ${loaded.error}`);
}
const directory: Directory = loaded.value;

const lines = fixture('gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl')
  .split('\n')
  .filter((line) => line.length > 0);

type Row = Record<string, unknown>;

/** Parses the raw line with `edit` applied. The raw JSON text keeps exact number lexemes. */
const rowWith = (index: number, edit: (row: Row) => void): string => {
  const row = JSON.parse(lines[index] ?? '') as Row;
  edit(row);
  return JSON.stringify(row);
};

const parse = (text: string): Outcome<GeminiRowResult> => parseGeminiRow(text, 0, directory);

const expectRejected = (outcome: Outcome<unknown>): void => {
  expect(outcome.kind).toBe('rejected');
};

const skuLine = (skuId: string): number => {
  const index = lines.findIndex((line) => line.includes(`"id": "${skuId}"`));
  if (index < 0) {
    throw new Error(`no fixture row for ${skuId}`);
  }
  return index;
};

describe('Gemini SKU map (G1, G2)', () => {
  it.each([
    ['D41E-77B0-2C1A', 'gemini-2.5-flash', 'input'],
    ['D41E-77B0-2C1B', 'gemini-2.5-flash', 'output'],
    ['8C7B-1A2E-9F03', 'gemini-2.5-pro', 'input'],
    ['8C7B-1A2E-9F04', 'gemini-2.5-pro', 'output'],
  ])('maps %s to %s %s', (skuId, model, direction) => {
    const outcome = parse(lines[skuLine(skuId)] ?? '');
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.value.usage.model).toBe(model);
      expect(outcome.value.usage.direction).toBe(direction);
      expect(outcome.value.charge.direction).toBe(direction);
      expect(outcome.value.charge.model).toBe(model);
    }
  });

  it('marks an unknown SKU ID unsupported with no observations', () => {
    const outcome = parse(rowWith(0, (row) => ((row['sku'] as Row)['id'] = 'FFFF-0000-0000')));
    expect(outcome.kind).toBe('unsupported');
  });
});

describe('Gemini validation (G3, G4, V2)', () => {
  it('rejects a SKU description that does not match the SKU ID', () => {
    expectRejected(
      parse(
        rowWith(
          0,
          (row) =>
            ((row['sku'] as Row)['description'] = 'Gemini 2.5 Pro Text Input Tokens - Predictions'),
        ),
      ),
    );
  });

  it('rejects a model label that does not match the SKU model', () => {
    expectRejected(
      parse(
        rowWith(0, (row) => {
          row['labels'] = [
            { key: 'owner', value: 'priya.nair@meridianls.example' },
            { key: 'agent', value: 'site-monitoring-assistant' },
            { key: 'model', value: 'gemini-2.5-pro' },
          ];
        }),
      ),
    );
  });

  it('marks non-empty credits unsupported', () => {
    expect(parse(rowWith(0, (row) => (row['credits'] = [{ amount: 1 }]))).kind).toBe('unsupported');
  });

  it('marks non-null adjustment_info unsupported', () => {
    expect(parse(rowWith(0, (row) => (row['adjustment_info'] = { id: 'x' }))).kind).toBe(
      'unsupported',
    );
  });

  it('marks a non-regular cost_type unsupported', () => {
    expect(parse(rowWith(0, (row) => (row['cost_type'] = 'promo'))).kind).toBe('unsupported');
  });

  it('marks a non-USD currency unsupported', () => {
    expect(parse(rowWith(0, (row) => (row['currency'] = 'EUR'))).kind).toBe('unsupported');
  });

  it('rejects a unit other than count', () => {
    expectRejected(parse(rowWith(0, (row) => ((row['usage'] as Row)['unit'] = 'bytes'))));
  });

  it.each([-1, 1.5])('rejects a non-integer or negative usage amount (%s)', (amount) => {
    expectRejected(parse(rowWith(0, (row) => ((row['usage'] as Row)['amount'] = amount))));
  });

  it('rejects a missing owner label', () => {
    expectRejected(
      parse(
        rowWith(0, (row) => {
          row['labels'] = [
            { key: 'agent', value: 'site-monitoring-assistant' },
            { key: 'model', value: 'gemini-2.5-flash' },
          ];
        }),
      ),
    );
  });

  it('rejects a missing project.id', () => {
    expectRejected(parse(rowWith(0, (row) => delete (row['project'] as Row)['id'])));
  });

  it('rejects a malformed usage_start_time', () => {
    expectRejected(parse(rowWith(0, (row) => (row['usage_start_time'] = '2026-08-05T00:00:00Z'))));
  });

  it('rejects a usage_end_time that is not start plus 24 hours', () => {
    expectRejected(parse(rowWith(0, (row) => (row['usage_end_time'] = '2026-08-05 12:00:00 UTC'))));
  });
});

describe('Gemini money (M2, M3, M4)', () => {
  const RAW_COST = '"cost": 0.107564,';

  it('reads cost 0.107564 from the raw lexeme as 10756400n', () => {
    const outcome = parse(lines[0] ?? '');
    expect(outcome.kind === 'resolved' && outcome.value.charge.amount).toBe(10756400n);
  });

  it('rejects a cost with more than eight fractional digits', () => {
    const text = (lines[0] ?? '').replace(RAW_COST, '"cost": 0.123456789,');
    expectRejected(parse(text));
  });

  it('rejects a cost in exponent notation', () => {
    const text = (lines[0] ?? '').replace(RAW_COST, '"cost": 1.07564e-1,');
    expectRejected(parse(text));
  });

  it.each([
    ['a huge positive exponent', '"effective_price": 3e1000000000'],
    ['a huge negative exponent', '"effective_price": 3e-1000000000'],
    ['an exponent just past the bound', '"effective_price": 3e101'],
    ['an oversized fraction', `"effective_price": 0.${'1'.repeat(80)}`],
  ])(
    'reports the price diagnostic unavailable for %s without changing the cost',
    (_label, price) => {
      const text = (lines[0] ?? '').replace('"effective_price": 3e-07', price);
      const outcome = parse(text);
      expect(outcome.kind).toBe('resolved');
      if (outcome.kind === 'resolved') {
        expect(outcome.value.charge.amount).toBe(10756400n);
        expect(outcome.value.priceDiagnostic).toEqual({ kind: 'unavailable' });
      }
    },
  );

  it('keeps the exported cost when the price diagnostic disagrees', () => {
    const text = (lines[0] ?? '').replace('"effective_price": 3e-07', '"effective_price": 1');
    const outcome = parse(text);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.value.charge.amount).toBe(10756400n);
      expect(outcome.value.priceDiagnostic).toMatchObject({
        kind: 'checked',
        exceedsTolerance: true,
      });
    }
  });
});

describe('Gemini unavailable values (G5)', () => {
  it('marks requests, cache, and web_search unavailable rather than zero', () => {
    const outcome = parse(lines[0] ?? '');
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.value.usage.requests).toEqual({ kind: 'unavailable' });
      expect(outcome.value.usage.cache).toEqual({ kind: 'unavailable' });
      expect(outcome.value.usage.webSearch).toEqual({ kind: 'unavailable' });
      expect(outcome.value.usage.tokens).toEqual({ kind: 'known', value: 358546 });
    }
  });
});

describe('Gemini attribution (A2, A4)', () => {
  it('resolves the Priya row to clinical-operations', () => {
    const outcome = parse(lines[0] ?? '');
    expect(outcome).toMatchObject({ kind: 'resolved' });
    if (outcome.kind === 'resolved') {
      expect(outcome.value.usage.userId).toBe('user_E7691888F28227066DD2FB86');
      expect(outcome.value.usage.groupId).toBe('clinical-operations');
    }
  });

  it('is unresolved when the owner is unknown', () => {
    const outcome = parse(
      rowWith(0, (row) => {
        row['labels'] = [
          { key: 'owner', value: 'nobody@meridianls.example' },
          { key: 'agent', value: 'x' },
          { key: 'model', value: 'gemini-2.5-flash' },
        ];
      }),
    );
    expect(outcome).toMatchObject({ kind: 'unresolved', reason: { code: 'gemini_owner_unknown' } });
  });

  it('rejects a malformed usage_start_time even when project.id is unknown', () => {
    const outcome = parse(
      rowWith(0, (row) => {
        row['usage_start_time'] = '2026-02-30 00:00:00 UTC';
        (row['project'] as Row)['id'] = 'meridian-unknown-prod';
      }),
    );
    expect(outcome.kind).toBe('rejected');
  });

  it('is unresolved when project.id is unknown', () => {
    const outcome = parse(
      rowWith(0, (row) => ((row['project'] as Row)['id'] = 'meridian-unknown-prod')),
    );
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: { code: 'gemini_project_unknown' },
    });
  });

  it('is unresolved when the team label differs from the project group', () => {
    const outcome = parse(
      rowWith(0, (row) => {
        (row['project'] as Row)['labels'] = [{ key: 'team', value: 'platform-engineering' }];
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: { code: 'gemini_team_label_mismatch' },
    });
  });

  it('is unresolved when the group is not in the owner group_ids', () => {
    const owner = directory.usersById.get('user_E7691888F28227066DD2FB86' as never);
    const other = [...directory.groupsById.values()].find(
      (group) => owner !== undefined && !owner.groupIds.includes(group.groupId),
    );
    if (other === undefined) throw new Error('no non-member group available');
    const outcome = parse(
      rowWith(0, (row) => {
        (row['project'] as Row)['id'] = other.gcpProjectId;
        (row['project'] as Row)['labels'] = [{ key: 'team', value: other.groupId }];
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: { code: 'gemini_group_not_member' },
    });
  });
});

describe('Gemini time (T2)', () => {
  it('assigns usage_start_time 2026-08-05 00:00:00 UTC to 2026-08-05 regardless of invoice month', () => {
    const outcome = parse(
      rowWith(0, (row) => {
        row['invoice'] = { month: '202609' };
        row['export_time'] = '2026-09-30 00:00:00.000 UTC';
      }),
    );
    expect(outcome.kind === 'resolved' && outcome.value.usage.period).toBe('2026-08-05');
  });
});
