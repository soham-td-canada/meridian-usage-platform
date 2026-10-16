import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvironment, type Environment } from '../../../packages/config/src/index.js';
import { fail, ok, type Directory, type Result } from '../../../packages/domain/src/index.js';
import { loadDirectory, type RawArtifact } from '../../../packages/ingestion/src/index.js';
import {
  ingestAndPersist,
  openPersistenceDatabase,
  type PersistenceDatabase,
} from '../../../packages/persistence/src/index.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const STARTER_KIT_DIR = join(REPO_ROOT, 'starter-kit');

const GEMINI_EXPORT = 'gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl';

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

/** The identity directory (the trusted source of roles and home groups). */
export function loadTrustedDirectory(starterKitDir: string): Result<Directory, string> {
  const dataDir = join(starterKitDir, 'data', 'directory');
  return loadDirectory(
    readFileSync(join(dataDir, 'users.json'), 'utf8'),
    readFileSync(join(dataDir, 'groups.json'), 'utf8'),
  );
}

export function starterKitArtifacts(starterKitDir: string): readonly RawArtifact[] {
  const data = join(starterKitDir, 'data');
  return [
    {
      source: 'directory',
      users: readBytes(join(data, 'directory', 'users.json')),
      groups: readBytes(join(data, 'directory', 'groups.json')),
    },
    { source: 'claude_usage', bytes: readBytes(join(data, 'claude', 'user_usage_report.json')) },
    { source: 'claude_cost', bytes: readBytes(join(data, 'claude', 'user_cost_report.json')) },
    { source: 'gemini_billing', bytes: readBytes(join(data, 'gemini', GEMINI_EXPORT)) },
  ];
}

export interface ProvisionedDatabase {
  readonly environment: Environment;
  readonly database: PersistenceDatabase;
}

/**
 * Ingests the starter-kit artifacts into the database. Replays are idempotent (Step 3/4) and
 * capability defaults only fill rows that do not exist yet, so later set_capability changes survive.
 */
export function provisionDatabase(input: {
  readonly environment: string;
  readonly databasePath: string;
  readonly starterKitDir: string;
  readonly recordedAt: string;
}): Result<ProvisionedDatabase, string> {
  const environment = parseEnvironment(input.environment);
  if (!environment.ok) {
    return fail(environment.error);
  }
  const database = openPersistenceDatabase(input.databasePath);
  const persisted = ingestAndPersist({
    database,
    artifacts: starterKitArtifacts(input.starterKitDir),
    environment: environment.value,
    recordedAt: input.recordedAt,
  });
  if (!persisted.ok) {
    database.close();
    return fail(`ingestion failed: ${persisted.error.kind}`);
  }
  return ok({ environment: environment.value, database });
}
