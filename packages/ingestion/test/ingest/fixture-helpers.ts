import { readFileSync } from 'node:fs';
import type { RawArtifact } from '../../src/ingest/types.js';

const STARTER_KIT = new URL('../../../../starter-kit/', import.meta.url);
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(path, STARTER_KIT)));

export const FIXTURE = {
  users: read('data/directory/users.json'),
  groups: read('data/directory/groups.json'),
  claudeUsage: read('data/claude/user_usage_report.json'),
  claudeCost: read('data/claude/user_cost_report.json'),
  gemini: read('data/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl'),
} as const;

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export interface FixtureOverrides {
  readonly users?: Uint8Array;
  readonly groups?: Uint8Array;
  readonly claudeUsage?: Uint8Array;
  readonly claudeCost?: Uint8Array;
  readonly gemini?: Uint8Array;
}

/** The supplied starter-kit artifacts, in the canonical order, with optional replacements. */
export function fixtureArtifacts(overrides: FixtureOverrides = {}): RawArtifact[] {
  return [
    {
      source: 'directory',
      users: overrides.users ?? FIXTURE.users,
      groups: overrides.groups ?? FIXTURE.groups,
    },
    { source: 'claude_usage', bytes: overrides.claudeUsage ?? FIXTURE.claudeUsage },
    { source: 'claude_cost', bytes: overrides.claudeCost ?? FIXTURE.claudeCost },
    { source: 'gemini_billing', bytes: overrides.gemini ?? FIXTURE.gemini },
  ];
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function claudeRows(bytes: Uint8Array): JsonRecord[] {
  const doc: unknown = JSON.parse(textOf(bytes));
  if (!isRecord(doc) || !Array.isArray(doc['data'])) {
    throw new Error('bad Claude fixture');
  }
  return doc['data'].filter(isRecord);
}

export const claudeBytes = (rows: readonly JsonRecord[]): Uint8Array =>
  bytesOf(JSON.stringify({ data: rows }));

export function geminiLines(bytes: Uint8Array): string[] {
  return textOf(bytes)
    .split('\n')
    .filter((line) => line !== '');
}

export const geminiBytes = (lines: readonly string[]): Uint8Array =>
  bytesOf(`${lines.join('\n')}\n`);

export function pairKeyOf(row: JsonRecord): string {
  const actor = row['actor'];
  const userId = isRecord(actor) ? actor['user_id'] : undefined;
  return JSON.stringify([userId, row['starting_at'], row['product'], row['model']]);
}

/** Clone with replaced fields; the original row is untouched. */
export const withFields = (row: JsonRecord, fields: JsonRecord): JsonRecord => ({
  ...row,
  ...fields,
});

export function first<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error('fixture row missing');
  }
  return item;
}
