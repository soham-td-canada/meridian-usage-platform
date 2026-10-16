import { createHash } from 'node:crypto';
import {
  canonicalJson,
  child,
  labelValue,
  nonEmptyString,
  path,
  type JsonNode,
} from '../raw/lexical-json.js';

export type SourceKind = 'directory' | 'claude_usage' | 'claude_cost' | 'gemini_billing';

export type RowSourceKind = Exclude<SourceKind, 'directory'>;

export const SOURCE_ORDER: readonly SourceKind[] = [
  'directory',
  'claude_usage',
  'claude_cost',
  'gemini_billing',
];

export const ROW_SOURCES: readonly RowSourceKind[] = [
  'claude_usage',
  'claude_cost',
  'gemini_billing',
];

/** Artifact identity is the source kind plus the SHA-256 of the raw bytes. */
export interface SourceArtifact {
  readonly source: SourceKind;
  readonly sha256: string;
  readonly byteLength: number;
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

export function artifactOf(source: RowSourceKind, bytes: Uint8Array): SourceArtifact {
  return { source, sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}

/** A directory is two files; its identity hashes both file hashes in a fixed order. */
export function directoryArtifactOf(users: Uint8Array, groups: Uint8Array): SourceArtifact {
  return {
    source: 'directory',
    sha256: sha256Hex(`users:${sha256Hex(users)}\ngroups:${sha256Hex(groups)}`),
    byteLength: users.byteLength + groups.byteLength,
  };
}

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Fingerprint of the raw row content only. */
export const rowFingerprint = (node: JsonNode): string => sha256Hex(canonicalJson(node));

function keyOf(source: RowSourceKind, parts: readonly (string | undefined)[]): string | undefined {
  const present: string[] = [];
  for (const part of parts) {
    if (part === undefined) {
      return undefined;
    }
    present.push(part);
  }
  return JSON.stringify([source, ...present]);
}

/**
 * Extracts the source-native key from raw fields before semantic validation. Returns undefined
 * when any component is missing or malformed.
 */
export function sourceKeyOf(source: RowSourceKind, node: JsonNode): string | undefined {
  switch (source) {
    case 'claude_usage':
    case 'claude_cost': {
      const common = [
        nonEmptyString(path(node, 'actor', 'user_id')),
        nonEmptyString(child(node, 'starting_at')),
        nonEmptyString(child(node, 'product')),
        nonEmptyString(child(node, 'model')),
        nonEmptyString(child(node, 'context_window')),
        nonEmptyString(child(node, 'inference_geo')),
        nonEmptyString(child(node, 'speed')),
      ];
      return keyOf(
        source,
        source === 'claude_cost' ? [...common, nonEmptyString(child(node, 'cost_type'))] : common,
      );
    }
    case 'gemini_billing': {
      const labels = child(node, 'labels');
      return keyOf(source, [
        nonEmptyString(child(node, 'billing_account_id')),
        nonEmptyString(path(node, 'sku', 'id')),
        nonEmptyString(child(node, 'usage_start_time')),
        nonEmptyString(path(node, 'project', 'id')),
        labelValue(labels, 'owner'),
        labelValue(labels, 'agent'),
        labelValue(labels, 'model'),
      ]);
    }
  }
}
