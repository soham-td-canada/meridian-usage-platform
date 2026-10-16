import type { Outcome, Result, SourceRef, UnresolvedReason } from '@meridian/domain';

export type JsonRecord = Readonly<Record<string, unknown>>;

type Stop =
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unsupported'; readonly code: string; readonly message: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason };

/** Thrown inside a row to stop processing it. Converted to an Outcome at the row boundary. */
export class RowStop extends Error {
  readonly stop: Stop;

  constructor(stop: Stop) {
    super(stop.kind === 'unresolved' ? stop.reason.code : stop.message);
    this.stop = stop;
  }
}

export function reject(code: string, message: string): never {
  throw new RowStop({ kind: 'rejected', code, message });
}

export function unsupported(code: string, message: string): never {
  throw new RowStop({ kind: 'unsupported', code, message });
}

export function unresolved(reason: UnresolvedReason): never {
  throw new RowStop({ kind: 'unresolved', reason });
}

/** Converts a domain Result into a row-level rejection, or returns its value. */
export function orReject<T>(result: Result<T, string>, code: string): T {
  if (!result.ok) {
    reject(code, result.error);
  }
  return result.value;
}

/**
 * Runs one source row and returns exactly one Outcome. Only RowStop is converted; any other
 * error is a programming fault and is rethrown.
 */
export function runRow<T>(source: SourceRef, body: () => T): Outcome<T> {
  try {
    return { kind: 'resolved', value: body() };
  } catch (error: unknown) {
    if (!(error instanceof RowStop)) {
      throw error;
    }
    const stop = error.stop;
    switch (stop.kind) {
      case 'rejected':
        return { kind: 'rejected', source, code: stop.code, message: stop.message };
      case 'unsupported':
        return { kind: 'unsupported', source, code: stop.code, message: stop.message };
      case 'unresolved':
        return { kind: 'unresolved', source, reason: stop.reason };
    }
  }
}

export function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject('schema', `${label} must be an object`);
  }
  return value as JsonRecord;
}

export function field(record: JsonRecord, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    reject('schema', `${label}.${key} is missing`);
  }
  return record[key];
}

export function stringField(record: JsonRecord, key: string, label: string): string {
  const value = field(record, key, label);
  if (typeof value !== 'string') {
    reject('schema', `${label}.${key} must be a string`);
  }
  return value;
}

export function booleanField(record: JsonRecord, key: string, label: string): boolean {
  const value = field(record, key, label);
  if (typeof value !== 'boolean') {
    reject('schema', `${label}.${key} must be a boolean`);
  }
  return value;
}

export function countField(record: JsonRecord, key: string, label: string): number {
  const value = field(record, key, label);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    reject('schema', `${label}.${key} must be a non-negative safe integer`);
  }
  return value;
}

export function arrayField(record: JsonRecord, key: string, label: string): readonly unknown[] {
  const value = field(record, key, label);
  if (!Array.isArray(value)) {
    reject('schema', `${label}.${key} must be an array`);
  }
  return value;
}
