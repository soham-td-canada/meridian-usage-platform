import type { RawClaudePairing } from '../raw/measures.js';
import { compareStrings } from '../ingest/identity.js';
import type { Issue } from './types.js';

export interface PairingRow {
  readonly source: 'claude_usage' | 'claude_cost';
  readonly accepted: boolean;
  readonly pairing: RawClaudePairing;
}

type Slot = 'usage' | 'tokens' | 'web_search';

const slotOf = (row: PairingRow): readonly Slot[] =>
  row.source === 'claude_usage'
    ? ['usage']
    : row.pairing.costType === 'tokens'
      ? ['tokens']
      : row.pairing.costType === 'web_search'
        ? ['web_search']
        : ['tokens', 'web_search'];

/** Claude usage/cost pairing over raw values. Counterparts that were excluded explain orphans. */
export function pairingIssues(rows: readonly PairingRow[]): Issue[] {
  const accepted: Record<Slot, Map<string, RawClaudePairing[]>> = {
    usage: new Map(),
    tokens: new Map(),
    web_search: new Map(),
  };
  const excluded: Record<Slot, Set<string>> = {
    usage: new Set(),
    tokens: new Set(),
    web_search: new Set(),
  };
  const issues: Issue[] = [];

  for (const row of rows) {
    const key = row.pairing.pairKey;
    for (const slot of slotOf(row)) {
      if (!row.accepted) {
        // An excluded row without a pair key cannot be attributed, so it explains nothing.
        if (key !== undefined) {
          excluded[slot].add(key);
        }
      } else if (key === undefined) {
        issues.push({ code: 'accepted_row_without_pair_key', subject: row.source });
      } else {
        accepted[slot].set(key, [...(accepted[slot].get(key) ?? []), row.pairing]);
      }
    }
  }

  const explained = (slot: Slot, key: string): boolean => excluded[slot].has(key);

  for (const slot of ['usage', 'tokens', 'web_search'] as const) {
    for (const [key, members] of accepted[slot]) {
      if (members.length > 1) {
        issues.push({ code: `${slot}_not_unique`, subject: key });
      }
    }
  }

  for (const [key, usageRows] of accepted.usage) {
    const usage = usageRows[0];
    const tokens = accepted.tokens.get(key) ?? [];
    const searches = accepted.web_search.get(key) ?? [];
    if (tokens.length === 0 && !explained('tokens', key)) {
      issues.push({ code: 'usage_missing_tokens_charge', subject: key });
    }
    const needsSearch = (usage?.webSearchRequests ?? 0n) > 0n;
    if (usage?.webSearchRequests === undefined) {
      issues.push({ code: 'web_search_requests_unmeasurable', subject: key });
    } else if (needsSearch && searches.length === 0 && !explained('web_search', key)) {
      issues.push({ code: 'usage_missing_web_search_charge', subject: key });
    }
    for (const charge of [...tokens, ...searches]) {
      if (usage !== undefined && usage.requests !== charge.requests) {
        issues.push({ code: 'paired_requests_mismatch', subject: key });
      }
      if (usage !== undefined && usage.rbacGroupId !== charge.rbacGroupId) {
        issues.push({ code: 'paired_rbac_group_mismatch', subject: key });
      }
      if (usage !== undefined && usage.email !== charge.email) {
        issues.push({ code: 'paired_email_mismatch', subject: key });
      }
    }
  }

  for (const slot of ['tokens', 'web_search'] as const) {
    for (const key of accepted[slot].keys()) {
      if (!accepted.usage.has(key) && !explained('usage', key)) {
        issues.push({ code: `${slot}_charge_without_usage`, subject: key });
      }
    }
  }

  return issues.sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(a.subject, b.subject),
  );
}
