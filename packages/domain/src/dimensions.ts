import type { Brand } from './brand.js';
import { fail, ok, type Result } from './result.js';

export type ProductName = Brand<string, 'ProductName'>;
export type ModelName = Brand<string, 'ModelName'>;
export type WorkloadName = Brand<string, 'WorkloadName'>;

const MAX_NAME_LENGTH = 64;
const OPEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Open-string dimensions are not closed enums, so new products and models are preserved
 * rather than rejected. Only a non-empty value without surrounding whitespace is required.
 */
function parseTrimmedName<Name extends string>(
  name: Name,
  raw: string,
): Result<Brand<string, Name>, string> {
  if (raw.length === 0 || raw !== raw.trim()) {
    return fail(`${name} must be a non-empty string without surrounding whitespace`);
  }
  return ok(raw as Brand<string, Name>);
}

/** Workload labels keep a stricter format than product and model names. */
function parseFormattedName<Name extends string>(
  name: Name,
  raw: string,
): Result<Brand<string, Name>, string> {
  const trimmed = parseTrimmedName(name, raw);
  if (!trimmed.ok) {
    return trimmed;
  }
  if (raw.length > MAX_NAME_LENGTH) {
    return fail(`${name} must be at most ${String(MAX_NAME_LENGTH)} characters`);
  }
  if (!OPEN_NAME_PATTERN.test(raw)) {
    return fail(`${name} contains invalid characters`);
  }
  return trimmed;
}

export const parseProductName = (raw: string): Result<ProductName, string> =>
  parseTrimmedName('ProductName', raw);

export const parseModelName = (raw: string): Result<ModelName, string> =>
  parseTrimmedName('ModelName', raw);

export const parseWorkloadName = (raw: string): Result<WorkloadName, string> =>
  parseFormattedName('WorkloadName', raw);

/** For trusted constants compiled into the codebase only. Throws on invalid input. */
export function trustedModelName(raw: string): ModelName {
  const parsed = parseModelName(raw);
  if (!parsed.ok) {
    throw new RangeError(parsed.error);
  }
  return parsed.value;
}
