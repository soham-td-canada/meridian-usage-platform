import { compareStrings } from './identity.js';
import type {
  ActiveRow,
  DisposedRow,
  Disposition,
  IngestionState,
  Observation,
  ProcessedRow,
} from './types.js';

/** Key-sorted serialization, so equality never depends on property insertion order. */
function stableSerialize(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => compareStrings(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

const observationDigest = (observations: readonly Observation[]): string =>
  stableSerialize(observations);

const compareRows = (a: ProcessedRow, b: ProcessedRow): number =>
  compareStrings(a.provenance.artifactSha256, b.provenance.artifactSha256) ||
  compareStrings(a.provenance.source, b.provenance.source) ||
  a.provenance.ref.rowIndex - b.provenance.ref.rowIndex;

export interface DisposeResult {
  readonly rows: readonly DisposedRow[];
  readonly nextActive: ReadonlyMap<string, ActiveRow>;
  readonly priorKeysAbsent: number;
}

/**
 * Assigns exactly one disposition to every row. Decisions depend only on row content grouped by
 * source key, never on input order. Conflict > restatement > quarantine > duplicate/accept.
 */
export function disposeRows(
  rows: readonly ProcessedRow[],
  prior: IngestionState,
  directorySha256: string,
): DisposeResult {
  const ordered = [...rows].sort(compareRows);
  const byKey = new Map<string, ProcessedRow[]>();
  for (const row of ordered) {
    const key = row.provenance.key;
    if (key !== undefined) {
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
  }

  const dispositions = new Map<ProcessedRow, Disposition>();
  const accepted: ActiveRow[] = [];
  const seenKeys = new Set<string>();

  for (const row of ordered) {
    const key = row.provenance.key;
    if (key === undefined) {
      dispositions.set(row, { kind: 'quarantined', reason: { kind: 'key_unextractable' } });
      continue;
    }
    const group = byKey.get(key) ?? [];
    const distinct = new Set(group.map((member) => member.provenance.fingerprint)).size;
    if (distinct > 1) {
      dispositions.set(row, { kind: 'conflict', distinctFingerprints: distinct });
      continue;
    }

    const priorRow = prior.active.get(key);
    if (priorRow !== undefined) {
      const sameContent =
        priorRow.fingerprint === row.provenance.fingerprint &&
        row.step2.kind === 'resolved' &&
        observationDigest(priorRow.observations) === observationDigest(row.step2.observations);
      if (!sameContent) {
        const sameFingerprint = priorRow.fingerprint === row.provenance.fingerprint;
        dispositions.set(row, {
          kind: 'restatement',
          reason: !sameFingerprint
            ? 'fingerprint_changed'
            : priorRow.directorySha256 !== directorySha256
              ? 'directory_changed'
              : 'observation_changed',
        });
      } else if (seenKeys.has(key)) {
        dispositions.set(row, { kind: 'duplicate' });
      } else {
        seenKeys.add(key);
        dispositions.set(row, { kind: 'accepted', replay: true });
      }
      continue;
    }

    if (row.step2.kind !== 'resolved') {
      dispositions.set(row, {
        kind: 'quarantined',
        reason: { kind: row.step2.kind, code: row.step2.code },
      });
    } else if (seenKeys.has(key)) {
      dispositions.set(row, { kind: 'duplicate' });
    } else {
      seenKeys.add(key);
      dispositions.set(row, { kind: 'accepted', replay: false });
      accepted.push({
        key,
        source: row.provenance.source,
        fingerprint: row.provenance.fingerprint,
        artifactSha256: row.provenance.artifactSha256,
        directorySha256,
        ref: row.provenance.ref,
        observations: row.step2.observations,
      });
    }
  }

  const merged = new Map<string, ActiveRow>(prior.active);
  for (const row of accepted) {
    merged.set(row.key, row);
  }
  const nextActive = new Map<string, ActiveRow>(
    [...merged.entries()].sort(([a], [b]) => compareStrings(a, b)),
  );

  const presentKeys = new Set(byKey.keys());
  let priorKeysAbsent = 0;
  for (const key of prior.active.keys()) {
    if (!presentKeys.has(key)) {
      priorKeysAbsent += 1;
    }
  }

  return {
    rows: ordered.map((row) => {
      const disposition = dispositions.get(row);
      if (disposition === undefined) {
        throw new RangeError('row without disposition');
      }
      return { ...row, disposition };
    }),
    nextActive,
    priorKeysAbsent,
  };
}
