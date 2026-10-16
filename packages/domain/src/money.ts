import { fail, ok, type Result } from './result.js';

/**
 * Money is an exact count of 1e-8 USD. It is never handled with floating-point arithmetic.
 */
export type Money = bigint;

export const MONEY_FRACTION_DIGITS = 8;

/** Longer lexemes are rejected before any BigInt conversion, so input size cannot drive cost. */
export const MONEY_MAX_LEXEME_LENGTH = 128;

const PLAIN_DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string (no sign, no exponent) into an exact integer count of
 * `10^-fractionDigits` units. Extra fractional digits are rejected rather than rounded.
 */
export function parseDecimalUnits(text: string, fractionDigits: number): Result<bigint, string> {
  if (text.length > MONEY_MAX_LEXEME_LENGTH) {
    return fail(`decimal may be at most ${String(MONEY_MAX_LEXEME_LENGTH)} characters`);
  }
  const match = PLAIN_DECIMAL.exec(text);
  if (match === null) {
    return fail('decimal must be an unsigned plain number without exponent');
  }
  const whole = match[1];
  const fraction = match[2] ?? '';
  if (whole === undefined || fraction.length > fractionDigits) {
    return fail(`decimal may have at most ${String(fractionDigits)} fractional digits`);
  }
  const scaledFraction = fraction.padEnd(fractionDigits, '0');
  const units = BigInt(whole) * 10n ** BigInt(fractionDigits) + BigInt(scaledFraction || '0');
  return ok(units);
}

/** Claude cents: 1 cent = 1e6 units, so six fractional cent digits fit exactly. */
export const parseClaudeCentsToMoney = (text: string): Result<Money, string> =>
  parseDecimalUnits(text, 6);

/** Gemini USD: 1 USD = 1e8 units. */
export const parseUsdToMoney = (text: string): Result<Money, string> =>
  parseDecimalUnits(text, MONEY_FRACTION_DIGITS);
