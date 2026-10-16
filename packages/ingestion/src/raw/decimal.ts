/** Exact decimal-lexeme arithmetic for raw controls. No Number arithmetic on money. */
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_LEXEME_LENGTH = 128;
const MAX_EXPONENT = 400;

/**
 * Converts a decimal lexeme to an exact integer count of `10^-scale` units.
 * Returns undefined when the value is not exactly representable at that scale.
 */
export function decimalToUnits(lexeme: string, scale: number): bigint | undefined {
  if (lexeme.length > MAX_LEXEME_LENGTH) {
    return undefined;
  }
  const match = DECIMAL.exec(lexeme);
  if (match === null) {
    return undefined;
  }
  const exponent = Number(match[4] ?? '0');
  if (Math.abs(exponent) > MAX_EXPONENT) {
    return undefined;
  }
  const fraction = match[3] ?? '';
  const digits = BigInt((match[2] ?? '') + fraction);
  const shift = exponent - fraction.length + scale;
  let units: bigint;
  if (shift >= 0) {
    units = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor !== 0n) {
      return undefined;
    }
    units = digits / divisor;
  }
  return match[1] === undefined ? units : -units;
}

/** An integer count from a lexeme such as `42` or `42.0`. Fractions and exponents are not counts. */
export function integerFromLexeme(lexeme: string): bigint | undefined {
  if (!/^-?\d+(?:\.0+)?$/.test(lexeme) || lexeme.length > MAX_LEXEME_LENGTH) {
    return undefined;
  }
  return decimalToUnits(lexeme, 0);
}
