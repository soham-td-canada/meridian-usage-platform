import { child, nonEmptyString, parseLexicalJson } from './lexical-json.js';

/** Raw group derivation tables built straight from the directory export. */
export interface RawDirectory {
  readonly groupByRbac: ReadonlyMap<string, string>;
  readonly groupByProject: ReadonlyMap<string, string>;
}

const AMBIGUOUS = '\u0000ambiguous';

function addUnique(map: Map<string, string>, key: string | undefined, group: string): void {
  if (key === undefined) {
    return;
  }
  map.set(key, map.has(key) ? AMBIGUOUS : group);
}

export function parseRawDirectory(groupsText: string): RawDirectory {
  const groupByRbac = new Map<string, string>();
  const groupByProject = new Map<string, string>();
  try {
    const groups = child(parseLexicalJson(groupsText), 'groups');
    if (groups?.t === 'array') {
      for (const entry of groups.items) {
        const id = nonEmptyString(child(entry, 'group_id'));
        if (id !== undefined) {
          addUnique(groupByRbac, nonEmptyString(child(entry, 'claude_rbac_group_id')), id);
          addUnique(groupByProject, nonEmptyString(child(entry, 'gcp_project_id')), id);
        }
      }
    }
  } catch {
    // An unreadable raw directory leaves every row unattributed, which reconciliation reports.
  }
  for (const map of [groupByRbac, groupByProject]) {
    for (const [key, value] of map) {
      if (value === AMBIGUOUS) {
        map.delete(key);
      }
    }
  }
  return { groupByRbac, groupByProject };
}
