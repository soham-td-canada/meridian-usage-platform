import type { ChargeObservation, SourceRef, UsageObservation } from '@meridian/domain';
import type { RawRow } from '../raw/measures.js';
import type { RowSourceKind, SourceArtifact, SourceKind } from './identity.js';

export type Observation = UsageObservation | ChargeObservation;

/** Provenance carried by every processed source row. */
export interface Provenance {
  readonly source: RowSourceKind;
  readonly artifactSha256: string;
  readonly ref: SourceRef;
  readonly key: string | undefined;
  readonly fingerprint: string;
}

/** Step 2 outcome reduced to what Step 3 may keep. Quarantine never retains payloads. */
export type Step2Result =
  | { readonly kind: 'resolved'; readonly observations: readonly Observation[] }
  | { readonly kind: 'unresolved' | 'rejected' | 'unsupported'; readonly code: string };

export type QuarantineReason =
  | { readonly kind: 'key_unextractable' }
  | { readonly kind: 'unresolved' | 'rejected' | 'unsupported'; readonly code: string };

export type Disposition =
  | { readonly kind: 'accepted'; readonly replay: boolean }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'conflict'; readonly distinctFingerprints: number }
  | {
      readonly kind: 'restatement';
      readonly reason: 'fingerprint_changed' | 'observation_changed' | 'directory_changed';
    }
  | { readonly kind: 'quarantined'; readonly reason: QuarantineReason };

/** A parsed source row before disposition. `raw` holds independent control values only. */
export interface ProcessedRow {
  readonly provenance: Provenance;
  readonly step2: Step2Result;
  readonly raw: RawRow;
}

export interface DisposedRow extends ProcessedRow {
  readonly disposition: Disposition;
}

/**
 * Public report record: SourceRef, source, key digest, fingerprint and disposition. No raw
 * controls, observations or key text (Gemini keys contain an owner email).
 */
export interface ReportRow {
  readonly provenance: Omit<Provenance, 'key'> & { readonly keyDigest: string | undefined };
  readonly disposition: Disposition;
}

export interface ActiveRow {
  readonly key: string;
  readonly source: RowSourceKind;
  readonly fingerprint: string;
  readonly artifactSha256: string;
  /** Identity of the directory whose attribution produced `observations`. */
  readonly directorySha256: string;
  readonly ref: SourceRef;
  readonly observations: readonly Observation[];
}

/** Plain in-memory value. Active rows are keyed by source key, in sorted key order. */
export interface IngestionState {
  readonly active: ReadonlyMap<string, ActiveRow>;
  readonly artifacts: readonly SourceArtifact[];
}

export const EMPTY_STATE: IngestionState = { active: new Map(), artifacts: [] };

export interface SourceFailure {
  readonly source: SourceKind;
  readonly artifactSha256: string | undefined;
  readonly code:
    'artifact_missing' | 'artifact_ambiguous' | 'utf8_invalid' | 'file_invalid' | 'torn_line';
  readonly message: string;
}

export type RawArtifact =
  | { readonly source: 'directory'; readonly users: Uint8Array; readonly groups: Uint8Array }
  | { readonly source: RowSourceKind; readonly bytes: Uint8Array };
