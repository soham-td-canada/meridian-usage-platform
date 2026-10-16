import { arrayField, asRecord, type JsonRecord } from '../shared/validate.js';

export interface ClaudeExportRoot {
  readonly data: readonly unknown[];
}

/**
 * Parses a Claude export envelope. Returns an error message for file-level failures,
 * which reject the whole file rather than individual rows.
 */
export function parseJsonRoot(text: string): ClaudeExportRoot | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'export is not valid JSON';
  }
  try {
    const record: JsonRecord = asRecord(parsed, 'export');
    return { data: arrayField(record, 'data', 'export') };
  } catch (error: unknown) {
    return error instanceof Error ? error.message : 'export has an invalid envelope';
  }
}
