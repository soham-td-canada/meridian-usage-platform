import type { Directory, Outcome } from '@meridian/domain';
import { loadClaudeCost } from '../claude/cost.js';
import { loadClaudeUsage } from '../claude/usage.js';
import { loadGeminiBilling, type GeminiRowResult } from '../gemini/billing.js';
import { rawClaudeCost, rawClaudeUsage } from '../raw/claude.js';
import type { RawDirectory } from '../raw/directory.js';
import { rawGeminiRow } from '../raw/gemini.js';
import { child, parseLexicalJson, type JsonNode } from '../raw/lexical-json.js';
import type { RawRow } from '../raw/measures.js';
import { rowFingerprint, sourceKeyOf, type RowSourceKind } from './identity.js';
import type { Observation, ProcessedRow, SourceFailure, Step2Result } from './types.js';

export interface SourceContext {
  readonly source: RowSourceKind;
  readonly artifactSha256: string;
  readonly directory: Directory;
  readonly rawDirectory: RawDirectory;
}

function failure(
  context: SourceContext,
  code: SourceFailure['code'],
  message: string,
): SourceFailure {
  return { source: context.source, artifactSha256: context.artifactSha256, code, message };
}

function reduce<T>(
  outcome: Outcome<T>,
  observations: (value: T) => readonly Observation[],
): Step2Result {
  switch (outcome.kind) {
    case 'resolved':
      return { kind: 'resolved', observations: observations(outcome.value) };
    case 'unresolved':
      return { kind: 'unresolved', code: outcome.reason.code };
    case 'rejected':
    case 'unsupported':
      return { kind: outcome.kind, code: outcome.code };
  }
}

function build(
  context: SourceContext,
  index: number,
  node: JsonNode,
  step2: Step2Result,
  raw: RawRow,
): ProcessedRow {
  return {
    provenance: {
      source: context.source,
      artifactSha256: context.artifactSha256,
      ref: { source: context.source, rowIndex: index },
      key: sourceKeyOf(context.source, node),
      fingerprint: rowFingerprint(node),
    },
    step2,
    raw,
  };
}

function claudeRows(context: SourceContext, text: string): readonly ProcessedRow[] | SourceFailure {
  const usage = context.source === 'claude_usage';
  const loaded = usage
    ? loadClaudeUsage(text, context.directory)
    : loadClaudeCost(text, context.directory);
  if (typeof loaded === 'string') {
    return failure(context, 'file_invalid', loaded);
  }
  let items: readonly JsonNode[];
  try {
    const data = child(parseLexicalJson(text), 'data');
    if (data?.t !== 'array') {
      return failure(context, 'file_invalid', 'export has no data array');
    }
    items = data.items;
  } catch {
    return failure(context, 'file_invalid', 'export is not strictly parseable JSON');
  }
  if (items.length !== loaded.length) {
    return failure(context, 'file_invalid', 'row count mismatch');
  }
  const steps = loaded.map((outcome) => reduce<Observation>(outcome, (value) => [value]));
  return steps.map((step2, index) => {
    const node = items[index];
    if (node === undefined) {
      throw new RangeError('row index out of range');
    }
    const raw = usage
      ? rawClaudeUsage(node, context.rawDirectory)
      : rawClaudeCost(node, context.rawDirectory);
    return build(context, index, node, step2, raw);
  });
}

function geminiRows(context: SourceContext, text: string): readonly ProcessedRow[] | SourceFailure {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const nodes: JsonNode[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      nodes.push(parseLexicalJson(line.replace(/\r$/, '')));
    } catch {
      return failure(context, 'torn_line', `line ${String(index)} is not valid JSON`);
    }
  }
  if (nodes.length === 0) {
    return failure(context, 'file_invalid', 'export contains no rows');
  }
  const outcomes = loadGeminiBilling(text, context.directory);
  if (outcomes.length !== nodes.length) {
    return failure(context, 'file_invalid', 'row count mismatch');
  }
  return outcomes.map((outcome, index) => {
    const node = nodes[index];
    if (node === undefined) {
      throw new RangeError('row index out of range');
    }
    return build(
      context,
      index,
      node,
      reduce<GeminiRowResult>(outcome, (value) => [value.usage, value.charge]),
      rawGeminiRow(node, context.rawDirectory),
    );
  });
}

/** Processes one decoded source artifact. A file-level failure yields no row outcomes. */
export function processSource(
  context: SourceContext,
  text: string,
): readonly ProcessedRow[] | SourceFailure {
  return context.source === 'gemini_billing'
    ? geminiRows(context, text)
    : claudeRows(context, text);
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
