/**
 * Lexeme capture for JSON numbers. `JSON.parse` loses the source text of numbers, but Gemini
 * `cost` must be read from the raw lexeme to keep exact money. Node's reviver `context.source`
 * exposes that text for primitive values.
 */
export interface ParsedJson {
  readonly value: unknown;
  readonly lexemes: WeakMap<object, ReadonlyMap<string, string>>;
}

type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { readonly source?: string },
) => unknown;

/** Node 22 supports `context.source`, but the TypeScript lib typing for JSON.parse does not. */
const parseWithSource: (text: string, reviver: SourceReviver) => unknown = JSON.parse;

export function parseJsonWithLexemes(text: string): ParsedJson {
  const lexemes = new WeakMap<object, Map<string, string>>();
  const reviver: SourceReviver = function (key, value, context) {
    if (
      typeof value === 'number' &&
      context?.source !== undefined &&
      typeof this === 'object' &&
      this !== null
    ) {
      const existing = lexemes.get(this) ?? new Map<string, string>();
      existing.set(key, context.source);
      lexemes.set(this, existing);
    }
    return value;
  };
  return { value: parseWithSource(text, reviver), lexemes };
}

/** Raw source text of a JSON number, or undefined if the value was not a number. */
export function lexemeOf(parsed: ParsedJson, holder: object, key: string): string | undefined {
  return parsed.lexemes.get(holder)?.get(key);
}
