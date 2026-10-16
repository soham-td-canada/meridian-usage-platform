import { loadDirectory } from '../directory/adapter.js';
import { parseRawDirectory } from '../raw/directory.js';
import type { Platform } from '../raw/measures.js';
import type { DateWindow } from '../reconcile/gaps.js';
import { reconcile, type ReconciliationReport } from '../reconcile/reconcile.js';
import { computeRunStatus, type RunStatus } from '../reconcile/status.js';
import { disposeRows } from './dispose.js';
import {
  artifactOf,
  compareStrings,
  directoryArtifactOf,
  keyDigestOf,
  ROW_SOURCES,
  SOURCE_ORDER,
  type RowSourceKind,
  type SourceArtifact,
} from './identity.js';
import { decodeUtf8, processSource } from './process.js';
import {
  EMPTY_STATE,
  type DisposedRow,
  type IngestionState,
  type Observation,
  type ProcessedRow,
  type ReportRow,
  type RawArtifact,
  type SourceFailure,
} from './types.js';

export interface IngestionCounts {
  readonly rows: number;
  readonly accepted: number;
  readonly replayed: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly restatements: number;
  readonly quarantined: number;
  readonly priorKeysAbsent: number;
}

export interface IngestionReport {
  readonly status: RunStatus;
  readonly artifacts: readonly SourceArtifact[];
  readonly directoryFailure: SourceFailure | undefined;
  readonly sourceFailures: readonly SourceFailure[];
  readonly counts: IngestionCounts;
  readonly rows: readonly ReportRow[];
  readonly reconciliation: ReconciliationReport;
}

export interface IngestionResult {
  readonly state: IngestionState;
  readonly report: IngestionReport;
}

export interface IngestOptions {
  readonly expectedWindows?: Readonly<Partial<Record<Platform, DateWindow>>>;
}

/** The inputs of a run after parsing and disposition, before reconciliation. */
export interface RunData {
  readonly state: IngestionState;
  readonly artifacts: readonly SourceArtifact[];
  readonly directoryFailure: SourceFailure | undefined;
  readonly sourceFailures: readonly SourceFailure[];
  readonly rows: readonly DisposedRow[];
  readonly canonical: readonly Observation[];
  readonly priorKeysAbsent: number;
}

const EMPTY_COUNTS: IngestionCounts = {
  rows: 0,
  accepted: 0,
  replayed: 0,
  duplicates: 0,
  conflicts: 0,
  restatements: 0,
  quarantined: 0,
  priorKeysAbsent: 0,
};

function uniqueSorted(artifacts: readonly SourceArtifact[]): SourceArtifact[] {
  const seen = new Map<string, SourceArtifact>();
  for (const artifact of artifacts) {
    seen.set(`${artifact.source}:${artifact.sha256}`, artifact);
  }
  return [...seen.values()].sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      compareStrings(a.sha256, b.sha256),
  );
}

function directoryFailure(
  code: SourceFailure['code'],
  message: string,
  artifactSha256?: string,
): SourceFailure {
  return { source: 'directory', artifactSha256, code, message };
}

/** Parses, dispositions and collects canonical observations. Pure and order-independent. */
export function processArtifacts(
  artifacts: readonly RawArtifact[],
  prior: IngestionState = EMPTY_STATE,
): RunData {
  const identities: SourceArtifact[] = [];
  const directories: Extract<RawArtifact, { source: 'directory' }>[] = [];
  const sources = new Map<string, { identity: SourceArtifact; bytes: Uint8Array }>();
  for (const artifact of artifacts) {
    if (artifact.source === 'directory') {
      identities.push(directoryArtifactOf(artifact.users, artifact.groups));
      directories.push(artifact);
    } else {
      const identity = artifactOf(artifact.source, artifact.bytes);
      identities.push(identity);
      sources.set(`${identity.source}:${identity.sha256}`, { identity, bytes: artifact.bytes });
    }
  }
  const unique = uniqueSorted(identities);
  const blocked = (failure: SourceFailure): RunData => ({
    state: prior,
    artifacts: unique,
    directoryFailure: failure,
    sourceFailures: [],
    rows: [],
    canonical: [],
    priorKeysAbsent: 0,
  });

  const directoryIdentities = unique.filter((a) => a.source === 'directory');
  if (directoryIdentities.length === 0) {
    return blocked(directoryFailure('artifact_missing', 'no directory artifact supplied'));
  }
  const firstDirectory = directoryIdentities[0];
  if (directoryIdentities.length > 1 || firstDirectory === undefined) {
    return blocked(directoryFailure('artifact_ambiguous', 'more than one distinct directory'));
  }
  const directoryInput = directories.find(
    (d) => directoryArtifactOf(d.users, d.groups).sha256 === firstDirectory.sha256,
  );
  const usersText = directoryInput === undefined ? undefined : decodeUtf8(directoryInput.users);
  const groupsText = directoryInput === undefined ? undefined : decodeUtf8(directoryInput.groups);
  if (usersText === undefined || groupsText === undefined) {
    return blocked(
      directoryFailure('utf8_invalid', 'directory is not valid UTF-8', firstDirectory.sha256),
    );
  }
  const loaded = loadDirectory(usersText, groupsText);
  if (!loaded.ok) {
    return blocked(
      directoryFailure('file_invalid', 'directory files are invalid', firstDirectory.sha256),
    );
  }
  const rawDirectory = parseRawDirectory(groupsText);

  const processed: ProcessedRow[] = [];
  const failures: SourceFailure[] = [];
  const failedArtifacts = new Set<string>();
  for (const source of ROW_SOURCES) {
    const present = unique.filter((a) => a.source === source);
    if (present.length === 0) {
      failures.push({
        source,
        artifactSha256: undefined,
        code: 'artifact_missing',
        message: 'source artifact not supplied',
      });
    }
    for (const identity of present) {
      const entry = sources.get(`${identity.source}:${identity.sha256}`);
      const text = entry === undefined ? undefined : decodeUtf8(entry.bytes);
      if (text === undefined) {
        failedArtifacts.add(`${identity.source}:${identity.sha256}`);
        failures.push({
          source,
          artifactSha256: identity.sha256,
          code: 'utf8_invalid',
          message: 'artifact is not valid UTF-8',
        });
        continue;
      }
      const result = processSource(
        {
          source,
          artifactSha256: identity.sha256,
          directory: loaded.value,
          rawDirectory,
        },
        text,
      );
      if ('code' in result) {
        failedArtifacts.add(`${identity.source}:${identity.sha256}`);
        failures.push(result);
      } else {
        processed.push(...result);
      }
    }
  }

  const disposed = disposeRows(processed, prior, firstDirectory.sha256);
  const canonical = disposed.rows
    .filter((row) => row.disposition.kind === 'accepted' && row.step2.kind === 'resolved')
    .flatMap((row) => (row.step2.kind === 'resolved' ? row.step2.observations : []));

  return {
    state: {
      active: disposed.nextActive,
      artifacts: uniqueSorted([
        ...prior.artifacts,
        ...unique.filter((a) => !failedArtifacts.has(`${a.source}:${a.sha256}`)),
      ]),
    },
    artifacts: unique,
    directoryFailure: undefined,
    sourceFailures: failures,
    rows: disposed.rows,
    canonical,
    priorKeysAbsent: disposed.priorKeysAbsent,
  };
}

function reportRowOf(row: DisposedRow): ReportRow {
  const { key, ...rest } = row.provenance;
  return {
    provenance: { ...rest, keyDigest: key === undefined ? undefined : keyDigestOf(key) },
    disposition: row.disposition,
  };
}

function countsOf(data: RunData): IngestionCounts {
  const count = (kind: string, replay?: boolean): number =>
    data.rows.filter(
      (row) =>
        row.disposition.kind === kind &&
        (replay === undefined ||
          (row.disposition.kind === 'accepted' && row.disposition.replay === replay)),
    ).length;
  return {
    rows: data.rows.length,
    accepted: count('accepted', false),
    replayed: count('accepted', true),
    duplicates: count('duplicate'),
    conflicts: count('conflict'),
    restatements: count('restatement'),
    quarantined: count('quarantined'),
    priorKeysAbsent: data.priorKeysAbsent,
  };
}

/** Reconciles and builds the final result. `canonical` may be overridden, e.g. to prove tamper detection. */
export function finalizeRun(
  data: RunData,
  options: IngestOptions = {},
  canonical: readonly Observation[] = data.canonical,
): IngestionResult {
  const failedSources = new Set<RowSourceKind>(
    data.sourceFailures
      .map((failure) => failure.source)
      .filter((s): s is RowSourceKind => s !== 'directory'),
  );
  const reconciliation: ReconciliationReport =
    data.directoryFailure === undefined
      ? reconcile({
          rows: data.rows,
          canonical,
          failedSources,
          ...(options.expectedWindows === undefined
            ? {}
            : { expectedWindows: options.expectedWindows }),
        })
      : { checks: [], gaps: [] };
  const counts = data.directoryFailure === undefined ? countsOf(data) : EMPTY_COUNTS;
  const status = computeRunStatus({
    directoryFailed: data.directoryFailure !== undefined,
    sourceFailures: data.sourceFailures.length,
    exclusions: counts.duplicates + counts.conflicts + counts.restatements + counts.quarantined,
    checks: reconciliation.checks,
  });
  return {
    state: data.state,
    report: {
      status,
      artifacts: data.artifacts,
      directoryFailure: data.directoryFailure,
      sourceFailures: data.sourceFailures,
      counts,
      rows: data.rows.map(reportRowOf),
      reconciliation,
    },
  };
}

/** Deterministic, in-memory ingestion. No clocks, no randomness, no I/O. */
export function ingest(
  artifacts: readonly RawArtifact[],
  prior: IngestionState = EMPTY_STATE,
  options: IngestOptions = {},
): IngestionResult {
  return finalizeRun(processArtifacts(artifacts, prior), options);
}
