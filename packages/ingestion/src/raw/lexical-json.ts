/**
 * Minimal strict JSON parser that preserves number lexemes. It is part of the raw-control path
 * and deliberately shares nothing with the Step 2 adapters.
 */
export type JsonNode =
  | { readonly t: 'null' }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'number'; readonly lexeme: string }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'array'; readonly items: readonly JsonNode[] }
  | { readonly t: 'object'; readonly entries: ReadonlyMap<string, JsonNode> };

const MAX_DEPTH = 128;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    this.skipWhitespace();
    const node = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw new SyntaxError('trailing content');
    }
    return node;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        this.pos += 1;
      } else {
        return;
      }
    }
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) {
      throw new SyntaxError('nesting too deep');
    }
    const c = this.text[this.pos];
    if (c === '{') {
      return this.parseObject(depth);
    }
    if (c === '[') {
      return this.parseArray(depth);
    }
    if (c === '"') {
      return { t: 'string', v: this.parseString() };
    }
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 4;
      return { t: 'bool', v: true };
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 5;
      return { t: 'bool', v: false };
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 4;
      return { t: 'null' };
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) {
      throw new SyntaxError('unexpected token');
    }
    this.pos += match[0].length;
    return { t: 'number', lexeme: match[0] };
  }

  private parseObject(depth: number): JsonNode {
    this.pos += 1;
    const entries = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return { t: 'object', entries };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        throw new SyntaxError('expected key');
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') {
        throw new SyntaxError('expected colon');
      }
      this.pos += 1;
      this.skipWhitespace();
      // Matches JSON.parse: the last duplicate key wins.
      entries.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === '}') {
        return { t: 'object', entries };
      }
      if (next !== ',') {
        throw new SyntaxError('expected comma');
      }
    }
  }

  private parseArray(depth: number): JsonNode {
    this.pos += 1;
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return { t: 'array', items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === ']') {
        return { t: 'array', items };
      }
      if (next !== ',') {
        throw new SyntaxError('expected comma');
      }
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos += 1;
    for (;;) {
      if (this.pos >= this.text.length) {
        throw new SyntaxError('unterminated string');
      }
      const c = this.text.charCodeAt(this.pos);
      if (c < 0x20) {
        throw new SyntaxError('control character in string');
      }
      if (c === 0x5c) {
        this.pos += 2;
      } else if (c === 0x22) {
        this.pos += 1;
        break;
      } else {
        this.pos += 1;
      }
    }
    // The slice is a syntactically delimited literal; JSON.parse validates the escapes.
    const decoded: unknown = JSON.parse(this.text.slice(start, this.pos));
    if (typeof decoded !== 'string') {
      throw new SyntaxError('invalid string');
    }
    return decoded;
  }
}

/** Throws SyntaxError for any input that is not strictly valid JSON. */
export function parseLexicalJson(text: string): JsonNode {
  return new Parser(text).parseDocument();
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic serialization: sorted keys, no whitespace, number lexemes preserved. */
export function canonicalJson(node: JsonNode): string {
  switch (node.t) {
    case 'null':
      return 'null';
    case 'bool':
      return node.v ? 'true' : 'false';
    case 'number':
      return node.lexeme;
    case 'string':
      return JSON.stringify(node.v);
    case 'array':
      return `[${node.items.map(canonicalJson).join(',')}]`;
    case 'object':
      return `{${[...node.entries.keys()]
        .sort(compareKeys)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(requireEntry(node.entries, key))}`)
        .join(',')}}`;
  }
}

function requireEntry(entries: ReadonlyMap<string, JsonNode>, key: string): JsonNode {
  const value = entries.get(key);
  if (value === undefined) {
    throw new RangeError('missing entry');
  }
  return value;
}

export function child(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return node?.t === 'object' ? node.entries.get(key) : undefined;
}

export function path(node: JsonNode | undefined, ...keys: readonly string[]): JsonNode | undefined {
  let current = node;
  for (const key of keys) {
    current = child(current, key);
  }
  return current;
}

/** A string node's value, only when it is a non-empty string. */
export function nonEmptyString(node: JsonNode | undefined): string | undefined {
  return node?.t === 'string' && node.v.length > 0 ? node.v : undefined;
}

/** Reads `[{key, value}]` labels. Absent or duplicated keys are ambiguous and yield undefined. */
export function labelValue(labels: JsonNode | undefined, key: string): string | undefined {
  if (labels?.t !== 'array') {
    return undefined;
  }
  let found: string | undefined;
  let count = 0;
  for (const entry of labels.items) {
    if (nonEmptyString(child(entry, 'key')) === key) {
      count += 1;
      found = nonEmptyString(child(entry, 'value'));
    }
  }
  return count === 1 ? found : undefined;
}
