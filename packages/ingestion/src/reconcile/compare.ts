import { compareStrings } from '../ingest/identity.js';
import type { Rollup } from './rollup.js';
import type { DeltaLine } from './types.js';

export function compareRollups(
  selector: string,
  rawAll: Rollup,
  excluded: Rollup,
  canonical: Rollup,
  includeMeasure: (name: string) => boolean,
): DeltaLine[] {
  const buckets = new Set([...rawAll.keys(), ...excluded.keys(), ...canonical.keys()]);
  const lines: DeltaLine[] = [];
  for (const bucket of [...buckets].sort(compareStrings)) {
    const measures = new Set<string>();
    for (const rollup of [rawAll, excluded, canonical]) {
      for (const name of rollup.get(bucket)?.cells.keys() ?? []) {
        if (includeMeasure(name)) {
          measures.add(name);
        }
      }
    }
    for (const measure of [...measures].sort(compareStrings)) {
      const raw = rawAll.get(bucket)?.cells.get(measure);
      const exc = excluded.get(bucket)?.cells.get(measure);
      const can = canonical.get(bucket)?.cells.get(measure);
      const rawSum = raw?.sum ?? 0n;
      const excSum = exc?.sum ?? 0n;
      const canSum = can?.sum ?? 0n;
      lines.push({
        selector,
        bucket,
        measure,
        raw: rawSum,
        canonical: canSum,
        excluded: excSum,
        unexplained: rawSum - canSum - excSum,
        unmeasurable: (raw?.unmeasurable ?? false) || (exc?.unmeasurable ?? false),
      });
    }
  }
  return lines;
}

export const lineFails = (line: DeltaLine): boolean => line.unexplained !== 0n || line.unmeasurable;
