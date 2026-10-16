import {
  type ClaudeUsageObservation,
  type Directory,
  type Outcome,
  type SourceRef,
  type UsageObservation,
} from '@meridian/domain';
import { asRecord, countField, field, reject, runRow } from '../shared/validate.js';
import { attributeClaudeRow, claudeSourceRef, readClaudeRowFields } from './row.js';
import { parseJsonRoot } from './root.js';

const SOURCE = 'claude_usage';

/** Validates one Claude usage row. Requests and web-search counts come only from this source. */
export function parseClaudeUsageRow(
  raw: unknown,
  rowIndex: number,
  directory: Directory,
): Outcome<UsageObservation> {
  const source: SourceRef = claudeSourceRef(SOURCE, rowIndex);
  return runRow(source, () => {
    const record = asRecord(raw, 'usage row');
    const fields = readClaudeRowFields(record);

    const uncachedInput = countField(record, 'uncached_input_tokens', 'row');
    const cacheRead = countField(record, 'cache_read_input_tokens', 'row');
    const cacheCreation = asRecord(field(record, 'cache_creation', 'row'), 'cache_creation');
    const cache5m = countField(cacheCreation, 'ephemeral_5m_input_tokens', 'cache_creation');
    const cache1h = countField(cacheCreation, 'ephemeral_1h_input_tokens', 'cache_creation');
    const output = countField(record, 'output_tokens', 'row');
    const total = countField(record, 'total_tokens', 'row');
    const requests = countField(record, 'requests', 'row');
    const serverTool = asRecord(field(record, 'server_tool_use', 'row'), 'server_tool_use');
    const webSearch = countField(serverTool, 'web_search_requests', 'server_tool_use');

    const inputTotal = uncachedInput + cacheRead + cache5m + cache1h;
    if (total !== inputTotal + output) {
      reject('claude_total_tokens_mismatch', 'total_tokens must equal the sum of token fields');
    }

    const attribution = attributeClaudeRow(fields, directory);
    const observation: ClaudeUsageObservation = {
      platform: 'claude',
      kind: 'usage',
      userId: attribution.userId,
      groupId: attribution.groupId,
      period: fields.period,
      model: fields.model,
      dimension: fields.dimension,
      uncachedInput,
      cacheReadInput: cacheRead,
      cacheCreation5mInput: cache5m,
      cacheCreation1hInput: cache1h,
      output,
      inputTotal,
      requests: { kind: 'known', value: requests },
      webSearchRequests: { kind: 'known', value: webSearch },
    };
    return observation;
  });
}

/** Parses a whole Claude usage export. File-level structure errors fail the whole file. */
export function loadClaudeUsage(
  text: string,
  directory: Directory,
): Outcome<UsageObservation>[] | string {
  const root = parseJsonRoot(text);
  if (typeof root === 'string') {
    return root;
  }
  return root.data.map((row, index) => parseClaudeUsageRow(row, index, directory));
}
